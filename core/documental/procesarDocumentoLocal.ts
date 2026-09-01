import { extraerDatosFactura } from "./extractInvoiceData";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import { manejarClasificacion } from "./processClassification";

export const MIMES_LEGIBLES_COMO_FACTURA = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

export interface DocumentoLocalEntrante {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  nombreParaClasificar: string;
  captionEfectivo?: string;
  /**
   * Si el archivo llegó como adjunto de un correo, sus datos — para poder
   * responder ese correo (con hilo real, no uno nuevo) después de archivar.
   * Pedido explícito de Carlos tras un caso real: le pidió al chat que
   * archivara un documento Y respondiera el correo original con un link,
   * y sin esto el asistente no tenía forma de saber a qué correo/hilo
   * contestar.
   */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string };
}

/**
 * Punto único de decisión "¿esto es un gasto o un documento para archivar?"
 * para un archivo YA descargado localmente — sin importar de dónde vino
 * (Telegram, un adjunto de correo, o cualquier fuente futura). Antes esta
 * misma lógica (leer el contenido con extraerDatosFactura, y si es factura
 * mandar a procesarGastoEntrante, si no a manejarClasificacion) vivía
 * duplicada en receiveFile.ts (Telegram) y revisarCorreoNuevo.ts (correo
 * automático) — factorizado acá para no triplicarla al agregar un tercer
 * punto de entrada (capturar_correo bajo demanda).
 */
export async function procesarDocumentoLocal(
  entrada: DocumentoLocalEntrante
): Promise<"gasto_propuesto" | "gasto_pendiente_datos" | "archivo"> {
  if (entrada.mimeType && MIMES_LEGIBLES_COMO_FACTURA.includes(entrada.mimeType)) {
    try {
      const datosFactura = await extraerDatosFactura(entrada.rutaLocal, entrada.mimeType, entrada.captionEfectivo);
      if (datosFactura.esFacturaOGasto) {
        const resultado = await procesarGastoEntrante({
          chatId: entrada.chatId,
          rutaLocal: entrada.rutaLocal,
          nombreArchivoOriginal: entrada.nombreArchivoOriginal,
          mimeType: entrada.mimeType,
          datos: datosFactura,
        });
        return resultado === "propuesta_enviada" ? "gasto_propuesto" : "gasto_pendiente_datos";
      }
    } catch (error) {
      console.error("[procesarDocumentoLocal] Error leyendo el documento como factura (sigue como documento normal):", error);
    }
  }

  await manejarClasificacion({
    chatId: entrada.chatId,
    rutaLocal: entrada.rutaLocal,
    nombreArchivoOriginal: entrada.nombreArchivoOriginal,
    mimeType: entrada.mimeType,
    nombreParaClasificar: entrada.nombreParaClasificar,
    captionEfectivo: entrada.captionEfectivo,
    correoOrigen: entrada.correoOrigen,
  });
  return "archivo";
}
