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
  const candidatos = await buscar(
    empresa,
    { monto, moneda, fecha: datos.fecha || new Date().toISOString().slice(0, 10) }
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

function parsearImporteAsunto(raw: string, moneda: string): number {
  const limpio = raw.replace(/\s/g, "");
  const partes = limpio.split(/[.,]/);
  if (partes.length === 1) return Number(partes[0]);
  const ultima = partes.at(-1) ?? "";
  // COP suele llegar con punto de miles (690.267COP); EUR/USD con dos decimales (192.28EUR).
  if (ultima.length === 3 && moneda !== "EUR" && moneda !== "USD" && moneda !== "GBP") {
    return Number(partes.join(""));
  }
  const decimales = ultima.length <= 2;
  return Number(decimales ? `${partes.slice(0, -1).join("")}.${ultima}` : partes.join(""));
}

export function reconstruirGastoDesdeAsuntoPago(
  asunto: string,
  cuerpo: string,
  fechaCorreo: string,
  datosParciales: DatosFactura
): DatosFactura | undefined {
  const importes = [...asunto.matchAll(/(\d[\d.,]*)\s*(EUR|USD|GBP|COP|MXN|CRC)\b/gi)]
    .map((match) => {
      const moneda = match[2].toUpperCase();
      return { monto: parsearImporteAsunto(match[1], moneda), moneda };
    })
    .filter((item) => Number.isFinite(item.monto) && item.monto > 0);
  if (importes.length === 0) return undefined;

  const equivalente = importes.find((item) => item.moneda === "EUR") ?? importes[0];
  const principal = importes.find((item) => item.moneda !== equivalente.moneda) ?? equivalente;
  const fechaParseada = new Date(fechaCorreo.replace(/\s+at\s+/i, " "));
  const fecha = Number.isNaN(fechaParseada.getTime())
    ? datosParciales.fecha
    : fechaParseada.toISOString().slice(0, 10);
  const remitenteOriginal = cuerpo.match(/(?:^|\n)From:\s*([^<\n]+?)(?:\s*<|\n)/i)?.[1]?.trim();
  const concepto = asunto
    .replace(/^\s*(?:fwd?|rv):\s*/i, "")
    .replace(/\d[\d.,]*\s*(?:EUR|USD|GBP|COP|MXN|CRC)\s*(?:\|\s*)?/gi, "")
    .replace(/^\s*[-|:]\s*/, "")
    .trim() || "Pago con tarjeta";

  return {
    ...datosParciales,
    esFacturaOGasto: true,
    proveedor: datosParciales.proveedor,
    monto: principal.monto,
    moneda: principal.moneda,
    montoEquivalente: equivalente === principal ? undefined : equivalente.monto,
    monedaEquivalente: equivalente === principal ? undefined : equivalente.moneda,
    personaAsociada: datosParciales.personaAsociada || remitenteOriginal,
    contextoDeViaje: datosParciales.contextoDeViaje || /\b(?:viaje|vuelo|hotel|aeropuerto)\b/i.test(asunto),
    fecha: fecha || new Date().toISOString().slice(0, 10),
    concepto: datosParciales.concepto || concepto,
    reciboSimplificado: true,
    lineas: [{
      concepto: datosParciales.concepto || concepto,
      base: principal.monto,
      tipoIvaPct: 0,
      tratamientoFiscal: "inversion_sujeto_pasivo",
    }],
    confianza: "alta",
    razon:
      "Comprobante de pago con importes explícitos en el asunto; el proveedor debe confirmarse mediante un único movimiento bancario exacto.",
  };
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
  let datosLeidos: DatosFactura;
  try {
    datosLeidos = await extraerDatosFactura(
      rutaTrabajo,
      adjunto.mimeType,
      `Adjunto de correo. De: ${correo.de}. Asunto: ${correo.asunto}. ${cuerpo}`,
      adjunto.filename
    );
  } catch (error) {
    // Un comprobante emitido por el banco puede no contener el comercio y hacer que el lector
    // documental agote sus intentos. El reproceso puntual todavía puede continuar de forma segura
    // con los importes LITERALES del asunto y un único movimiento bancario exacto; no se degrada a
    // una decisión inventada ni se aplica este fallback al flujo normal del buzón.
    console.error("[reprocesarResolucionProveedor] La lectura documental no concluyó; se intenta el respaldo bancario exacto:", error);
    datosLeidos = {
      esFacturaOGasto: false,
      proveedor: "",
      monto: 0,
      moneda: "",
      fecha: "",
      concepto: "",
      reciboSimplificado: true,
      lineas: [],
      empresaProbable: empresa,
      confianza: "baja",
      razon: "La lectura documental no concluyó; pendiente de evidencia bancaria exacta.",
    };
  }
  const datosBase = datosLeidos.esFacturaOGasto
    ? datosLeidos
    : reconstruirGastoDesdeAsuntoPago(correo.asunto, cuerpo, correo.fecha, datosLeidos);
  if (!datosBase) throw new Error("La lectura no confirmó el gasto y el asunto no contiene importes verificables.");
  const proveedor = await resolverProveedorRealDesdeMovimiento(datosBase, empresa);
  const datos = { ...datosBase, proveedor, empresaProbable: empresa };
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
