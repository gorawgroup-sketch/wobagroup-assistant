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
export async function procesarDocumentoLocal(entrada: DocumentoLocalEntrante): Promise<"gasto" | "archivo"> {
  if (entrada.mimeType && MIMES_LEGIBLES_COMO_FACTURA.includes(entrada.mimeType)) {
    try {
      const datosFactura = await extraerDatosFactura(entrada.rutaLocal, entrada.mimeType, entrada.captionEfectivo);
      if (datosFactura.esFacturaOGasto) {
        await procesarGastoEntrante({
          chatId: entrada.chatId,
          rutaLocal: entrada.rutaLocal,
          nombreArchivoOriginal: entrada.nombreArchivoOriginal,
          mimeType: entrada.mimeType,
          datos: datosFactura,
        });
        return "gasto";
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
  });
  return "archivo";
}
