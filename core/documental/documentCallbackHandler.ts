import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from "../telegram/client";
import { consumirPropuestaClasificacion, obtenerPropuestaClasificacion } from "./classificationStore";
import { archivarDocumentoEnDrive } from "./archiveFile";
import { guardarPendienteReglaClasificacion } from "./pendienteReglaClasificacionStore";
import { guardarPendienteAlertaDocumento } from "./pendienteAlertaDocumentoStore";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[documentCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Maneja los botones de clasificación de documentos (doc_confirm / doc_reroute).
 * "✅ Sí, archivar aquí" es el ÚNICO camino de código que dispara la subida
 * real a Drive (archivarDocumentoEnDrive) — nunca ocurre automáticamente.
 */
export async function handleDocumentCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");

  // "📚 Enseñar regla" / "⏰ Crear alerta" NO consumen la propuesta — solo la
  // leen. "✅ Sí, archivar aquí" / "✏️ Elegir otra carpeta" siguen
  // disponibles después de usar cualquiera de estos dos.
  if (accion === "doc_regla" || accion === "doc_alerta") {
    const propuestaPeek = await obtenerPropuestaClasificacion(id);
    if (!propuestaPeek) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
      return;
    }

    await answerCallbackQuerySafe(callback.id);

    if (accion === "doc_regla") {
      await guardarPendienteReglaClasificacion({
        chatId: propuestaPeek.chatId,
        empresa: propuestaPeek.clasificacion.empresa,
        tipoDocumento: propuestaPeek.clasificacion.tipoDocumento,
        carpetaDestino: propuestaPeek.clasificacion.carpetaSugerida,
        nombreArchivoOriginal: propuestaPeek.nombreArchivoOriginal,
      });
      await sendTelegramMessage(
        propuestaPeek.chatId,
        `📚 Ok — respóndeme con la palabra o frase clave que identifica este tipo de documento (ej. un fragmento del nombre de archivo, del remitente, o del asunto). La próxima vez que un documento de ${propuestaPeek.clasificacion.empresa} coincida con eso, lo archivo directo en "${propuestaPeek.clasificacion.carpetaSugerida}" sin volver a preguntar.`
      );
    } else {
      await guardarPendienteAlertaDocumento({
        chatId: propuestaPeek.chatId,
        nombreArchivoOriginal: propuestaPeek.nombreArchivoOriginal,
        empresa: propuestaPeek.clasificacion.empresa,
        tipoDocumento: propuestaPeek.clasificacion.tipoDocumento,
      });
      await sendTelegramMessage(
        propuestaPeek.chatId,
        `⏰ Ok — respóndeme qué quieres que te recuerde sobre "${propuestaPeek.nombreArchivoOriginal}" y cuándo (ej. "avísame en 3 días si no se ha enviado a aduana", o "recuérdame el jueves confirmar con Alberto").`
      );
    }
    return;
  }

  const propuesta = await consumirPropuestaClasificacion(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (accion === "doc_reroute") {
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — respóndeme con la empresa y carpeta correctas para "${propuesta.nombreArchivoOriginal}".`,
      []
    );
    return;
  }

  // doc_confirm
  await answerCallbackQuerySafe(callback.id, "Subiendo a Drive...");

  const resultado = await archivarDocumentoEnDrive(propuesta);

  if (resultado.ok) {
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Archivado — ${propuesta.nombreArchivoOriginal}\n${resultado.mensaje}\n\n🔗 ${resultado.webViewLink}`,
      []
    );
  } else {
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ No se pudo archivar — ${propuesta.nombreArchivoOriginal}\n\n${resultado.mensaje}`,
      []
    );
  }
}
