import { access } from "node:fs/promises";
import { extraerDatosFactura } from "../documental/extractInvoiceData";
import { obtenerCuerpoCompletoCorreo } from "../gmail/client";
import { reDescargarAdjuntoSiFalta, regenerarComprobanteDesdeCuerpoSiFalta } from "../gmail/reDescargarAdjunto";
import { editTelegramMessage } from "../telegram/client";
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
  const recuperadoDesdeAdjunto = await reDescargarAdjuntoSiFalta(propuesta.rutaLocal, propuesta.origenAdjuntoGmail);
  if (!recuperadoDesdeAdjunto && !(await archivoExiste(propuesta.rutaLocal))) {
    const regenerado = await regenerarComprobanteDesdeCuerpoSiFalta(propuesta.rutaLocal, propuesta);
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
    propuesta.rutaLocal,
    propuesta.mimeType,
    contextoCorreo,
    propuesta.nombreArchivoOriginal
  );

  if (!datosReleidos.esFacturaOGasto) {
    throw new Error("La nueva lectura no confirmó que el documento sea un gasto; no se modificó la resolución anterior.");
  }
  const proveedor = datosReleidos.proveedor.trim();
  if (!proveedor) {
    throw new Error("La nueva lectura tampoco pudo identificar el proveedor real; no se creó ni modificó ningún gasto.");
  }

  // Conserva la empresa que el flujo original ya había resuelto si la nueva lectura no logra
  // determinarla. El resto de los datos se vuelve a leer del comprobante y del correo completos.
  const datos = {
    ...datosReleidos,
    empresaProbable:
      datosReleidos.empresaProbable === "desconocida"
        ? resolucion.empresaFinal
        : datosReleidos.empresaProbable,
  };

  const resultado = await procesarGastoEntrante({
    chatId: resolucion.chatId,
    rutaLocal: propuesta.rutaLocal,
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
