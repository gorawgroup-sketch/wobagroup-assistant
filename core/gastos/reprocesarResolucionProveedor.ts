import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { extraerDatosFactura, type DatosFactura } from "../documental/extractInvoiceData";
import { obtenerCuerpoCompletoCorreo, obtenerResumenCorreo } from "../gmail/client";
import { reDescargarAdjuntoSiFalta, regenerarComprobanteDesdeCuerpoSiFalta } from "../gmail/reDescargarAdjunto";
import { editTelegramMessage } from "../telegram/client";
import type { Empresa } from "../holded/client";
import { esProveedorNoIdentificado } from "../holded/duplicateSignals";
import { buscarMovimientoSimilar } from "../holded/write";
import {
  consumirResolucionContacto,
  type ResolucionContactoPendiente,
} from "./contactoResolucionStore";
import { procesarGastoEntrante, type ResultadoGastoEntrante } from "./procesarGastoEntrante";

async function archivoExiste(ruta: string): Promise<boolean> {
  try {
    await access(ruta);
    return true;
  } catch {
    return false;
  }
}

export async function resolverProveedorRealDesdeMovimiento(
  datos: DatosFactura,
  empresa: Empresa,
  buscar: typeof buscarMovimientoSimilar = buscarMovimientoSimilar
): Promise<string> {
  const proveedorLeido = datos.proveedor.trim();
  if (!esProveedorNoIdentificado(proveedorLeido)) return proveedorLeido;

  const usaEquivalente =
    typeof datos.montoEquivalente === "number" &&
    Boolean(datos.monedaEquivalente?.trim());
  const monto = usaEquivalente ? datos.montoEquivalente! : datos.monto;
  const moneda = usaEquivalente ? datos.monedaEquivalente!.trim().toUpperCase() : datos.moneda.trim().toUpperCase();
  const tolerancia = usaEquivalente ? Math.max(0.05, Math.abs(monto) * 0.02) : undefined;
  const candidatos = await buscar(
    empresa,
    { monto, moneda, fecha: datos.fecha || new Date().toISOString().slice(0, 10) },
    tolerancia
  );
  const proveedores = [...new Set(
    candidatos
      .map((movimiento) => movimiento.descripcion.trim())
      .filter((nombre) => nombre && !esProveedorNoIdentificado(nombre))
  )];
  if (proveedores.length !== 1) {
    throw new Error(
      proveedores.length === 0
        ? "El documento no identifica al proveedor y no existe un único movimiento bancario exacto que permita recuperarlo."
        : `El documento no identifica al proveedor y hay ${proveedores.length} movimientos/proveedores posibles; hace falta revisión humana.`
    );
  }
  return proveedores[0];
}

async function leerAdjuntoCorreo(
  mensajeIdGmail: string,
  chatId: number,
  empresa: Empresa,
  nombreArchivo?: string
): Promise<{ proveedor: string; resultado: ResultadoGastoEntrante }> {
  const correo = await obtenerResumenCorreo(mensajeIdGmail);
  const adjuntos = nombreArchivo
    ? correo.adjuntos.filter((adjunto) => adjunto.filename === nombreArchivo)
    : correo.adjuntos;
  if (adjuntos.length !== 1) {
    throw new Error(`Se esperaba un adjunto exacto y se encontraron ${adjuntos.length}; no se procesó nada.`);
  }
  const adjunto = adjuntos[0];
  const rutaTrabajo = join("/tmp", `wobi-reprocesar-${mensajeIdGmail}-${basename(adjunto.filename)}`);
  const recuperado = await reDescargarAdjuntoSiFalta(rutaTrabajo, {
    mensajeIdGmail,
    attachmentIdGmail: adjunto.attachmentId,
    partId: adjunto.partId,
  });
  if (!recuperado) throw new Error("No se pudo recuperar el adjunto exacto desde Gmail.");

  const cuerpo = await obtenerCuerpoCompletoCorreo(mensajeIdGmail);
  const datosLeidos = await extraerDatosFactura(
    rutaTrabajo,
    adjunto.mimeType,
    `Adjunto de correo. De: ${correo.de}. Asunto: ${correo.asunto}. ${cuerpo}`,
    adjunto.filename
  );
  if (!datosLeidos.esFacturaOGasto) throw new Error("La lectura no confirmó que el documento sea un gasto.");
  const proveedor = await resolverProveedorRealDesdeMovimiento(datosLeidos, empresa);
  const datos = { ...datosLeidos, proveedor, empresaProbable: empresa };
  const resultado = await procesarGastoEntrante({
    chatId,
    rutaLocal: rutaTrabajo,
    nombreArchivoOriginal: adjunto.filename,
    mimeType: adjunto.mimeType,
    datos,
    deColaCorreo: true,
    origenAdjuntoGmail: {
      mensajeIdGmail,
      attachmentIdGmail: adjunto.attachmentId,
      partId: adjunto.partId,
    },
    correoOrigen: {
      de: correo.de,
      asunto: correo.asunto,
      threadId: correo.threadId,
      messageIdHeader: correo.messageIdHeader,
      mensajeIdGmail,
    },
  });
  if (resultado !== "propuesta_enviada" && resultado !== "propuesta_pendiente_existente") {
    throw new Error(`El reproceso terminó como ${resultado}; no se entregó una propuesta nueva.`);
  }
  return { proveedor, resultado };
}

export async function reprocesarAdjuntoCorreoConProveedorBancario(
  mensajeIdGmail: string,
  chatId: number,
  empresa: Empresa,
  nombreArchivo?: string
): Promise<{ proveedor: string; resultado: ResultadoGastoEntrante }> {
  return leerAdjuntoCorreo(mensajeIdGmail, chatId, empresa, nombreArchivo);
}

/**
 * Relee una resolución defectuosa cuyo proveedor quedó vacío usando únicamente su correo y soporte
 * originales. No recorre el buzón, no crea el gasto y no concilia: entrega una propuesta nueva con
 * los mismos botones del flujo normal. El correo conserva su estado pendiente/no leído hasta que el
 * operador termine esa propuesta.
 */
export async function reprocesarResolucionConProveedorVacio(
  resolucion: ResolucionContactoPendiente
): Promise<{ proveedor: string; resultado: ResultadoGastoEntrante }> {
  if (resolucion.propuesta.proveedor.trim()) {
    throw new Error(`La resolución ${resolucion.id} ya tiene proveedor; este reparador solo admite proveedores vacíos.`);
  }

  const { propuesta } = resolucion;
  // Las resoluciones durables pueden conservar una ruta `/app/tmp/...` creada dentro de un deploy
  // anterior. Un comando de mantenimiento ejecutado con `railway run` comparte credenciales, pero no
  // ese filesystem. `/tmp` existe en ambos entornos y la propuesta nueva conserva el origen Gmail,
  // por lo que el callback de producción podrá volver a descargar el mismo archivo si hace falta.
  const rutaTrabajo = join("/tmp", `wobi-reprocesar-${resolucion.id}-${basename(propuesta.nombreArchivoOriginal || "comprobante")}`);
  const recuperadoDesdeAdjunto = await reDescargarAdjuntoSiFalta(rutaTrabajo, propuesta.origenAdjuntoGmail);
  if (!recuperadoDesdeAdjunto && !(await archivoExiste(rutaTrabajo))) {
    const regenerado = await regenerarComprobanteDesdeCuerpoSiFalta(rutaTrabajo, propuesta);
    if (!regenerado) {
      throw new Error("No se pudo recuperar el comprobante original desde Gmail; la resolución se conserva intacta.");
    }
  }

  const cuerpo = propuesta.correoOrigen?.mensajeIdGmail
    ? await obtenerCuerpoCompletoCorreo(propuesta.correoOrigen.mensajeIdGmail)
    : "";
  const contextoCorreo = propuesta.correoOrigen
    ? `Adjunto de correo. De: ${propuesta.correoOrigen.de}. Asunto: ${propuesta.correoOrigen.asunto}. ${cuerpo}`
    : undefined;
  const datosReleidos = await extraerDatosFactura(
    rutaTrabajo,
    propuesta.mimeType,
    contextoCorreo,
    propuesta.nombreArchivoOriginal
  );

  if (!datosReleidos.esFacturaOGasto) {
    throw new Error("La nueva lectura no confirmó que el documento sea un gasto; no se modificó la resolución anterior.");
  }
  // Conserva la empresa que el flujo original ya había resuelto si la nueva lectura no logra
  // determinarla. El resto de los datos se vuelve a leer del comprobante y del correo completos.
  const datosBase = {
    ...datosReleidos,
    empresaProbable:
      datosReleidos.empresaProbable === "desconocida"
        ? resolucion.empresaFinal
        : datosReleidos.empresaProbable,
  };
  const proveedor = await resolverProveedorRealDesdeMovimiento(datosBase, resolucion.empresaFinal);
  const datos = { ...datosBase, proveedor };

  const resultado = await procesarGastoEntrante({
    chatId: resolucion.chatId,
    rutaLocal: rutaTrabajo,
    nombreArchivoOriginal: propuesta.nombreArchivoOriginal,
    mimeType: propuesta.mimeType,
    datos,
    deColaCorreo: propuesta.deColaCorreo,
    origenAdjuntoGmail: propuesta.origenAdjuntoGmail,
    correoOrigen: propuesta.correoOrigen,
  });

  if (resultado !== "propuesta_enviada" && resultado !== "propuesta_pendiente_existente") {
    throw new Error(`El reproceso terminó como ${resultado}; se conserva la resolución anterior para revisión segura.`);
  }

  const retirada = await consumirResolucionContacto(resolucion.id);
  if (!retirada) {
    throw new Error(`La propuesta nueva fue entregada, pero la resolución anterior ${resolucion.id} ya no estaba disponible.`);
  }

  await editTelegramMessage(
    resolucion.chatId,
    resolucion.messageId,
    `✅ Reprocesé este comprobante desde su correo y soporte originales. Proveedor identificado: "${proveedor}". ` +
      `Te entregué una propuesta nueva con las alternativas y acciones completas; este mensaje anterior quedó retirado.`,
    []
  ).catch((error) =>
    console.error("[reprocesarResolucionProveedor] La propuesta se reemplazó, pero no se pudo actualizar el mensaje viejo:", error)
  );

  return { proveedor, resultado };
}
