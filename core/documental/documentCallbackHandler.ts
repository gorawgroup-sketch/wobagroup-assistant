import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { consumirPropuestaClasificacion } from "./classificationStore";
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
 * IMPORTANTE: "✅ Sí, archivar aquí" NO sube nada a Drive todavía — solo
 * confirma por texto dónde quedaría archivado. La subida real es el Paso 3.
 */
export async function handleDocumentCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");
  const propuesta = consumirPropuestaClasificacion(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (accion === "doc_reroute") {
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — respóndeme con la empresa y carpeta correctas para "${propuesta.nombreArchivo}".`,
      []
    );
    return;
  }

  // doc_confirm
  await answerCallbackQuerySafe(callback.id, "Confirmado.");
  await editTelegramMessage(
    propuesta.chatId,
    propuesta.messageId,
    `✅ Quedaría archivado en "${propuesta.clasificacion.carpetaSugerida}" (${propuesta.clasificacion.empresa}).\n\n` +
      `(Todavía no se sube realmente a Drive — eso es el Paso 3.)`,
    []
  );
}
