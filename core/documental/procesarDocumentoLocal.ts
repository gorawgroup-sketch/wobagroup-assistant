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
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; deColaCorreo?: boolean; /** Gmail interno (correo.id) + attachmentId del adjunto real — permite volver a descargarlo de Gmail si la copia local en tmp/uploads se pierde (ej. un redeploy de Railway entre que se descarga y que se usa). */ mensajeIdGmail?: string; attachmentIdGmail?: string };
  /**
   * Pedido explícito de Carlos, tras un caso real: un correo con 2 adjuntos
   * distintos (mismo expediente de envío marítimo) mandó 2 propuestas
   * seguidas y pareció que había llegado duplicado — eran 2 documentos
   * reales distintos, pero nada lo aclaraba. Se propaga hasta el mensaje
   * final para que quede explícito ("Adjunto 2 de 2 de este correo").
   */
  notaAdjunto?: string;
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
): Promise<"gasto_propuesto" | "gasto_pendiente_datos" | "gasto_duplicado" | "archivo"> {
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
          deColaCorreo: entrada.correoOrigen?.deColaCorreo,
          origenAdjuntoGmail:
            entrada.correoOrigen?.mensajeIdGmail && entrada.correoOrigen?.attachmentIdGmail
              ? { mensajeIdGmail: entrada.correoOrigen.mensajeIdGmail, attachmentIdGmail: entrada.correoOrigen.attachmentIdGmail }
              : undefined,
          correoOrigen: entrada.correoOrigen
            ? {
                de: entrada.correoOrigen.de,
                asunto: entrada.correoOrigen.asunto,
                threadId: entrada.correoOrigen.threadId,
                messageIdHeader: entrada.correoOrigen.messageIdHeader,
                mensajeIdGmail: entrada.correoOrigen.mensajeIdGmail,
              }
            : undefined,
        });
        if (resultado === "propuesta_enviada") return "gasto_propuesto";
        if (resultado === "propuesta_duplicada") return "gasto_duplicado";
        return "gasto_pendiente_datos";
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
    notaAdjunto: entrada.notaAdjunto,
  });
  return "archivo";
}
