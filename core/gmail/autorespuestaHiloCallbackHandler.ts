import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { resolverHiloAutorespuesta } from "./hiloAutorespuestaStore";
import { procesarHiloAutorespuestaAprobado } from "../jobs/revisarConversacionesAutomaticas";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[autorespuestaHiloCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Botones "✅ Sí, automática" / "❌ No, normal" de la pregunta por hilo nuevo
 * (ver revisarConversacionesAutomaticas.ts) — decisión centralizada en
 * superadmin (ver ACCIONES_SENSIBLES en authorizedUsersSheet.ts): es la
 * decisión MÁS sensible de todo el sistema de correo, porque da autorización
 * PERMANENTE para futuros envíos automáticos sin volver a preguntar.
 */
export async function handleAutorespuestaHiloCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  if (!data || !chatId || !messageId) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, threadId] = data.split(":");

  if (accion === "autohilo_rechazar") {
    const actualizado = await resolverHiloAutorespuesta(threadId, "rechazado");
    if (!actualizado) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Ok, queda en el flujo normal.");
    await editTelegramMessage(
      chatId,
      messageId,
      "❌ Esta conversación queda en el flujo normal de correo (no automática) — la verás en la revisión de siempre.",
      []
    );
    return;
  }

  if (accion === "autohilo_aprobar") {
    const actualizado = await resolverHiloAutorespuesta(threadId, "aprobado");
    if (!actualizado) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Automática — respondiendo...");
    await editTelegramMessage(
      chatId,
      messageId,
      `✅ Conversación automática con ${actualizado.de} ("${actualizado.asunto}") — a partir de ahora respondo sola en este hilo.`,
      []
    );

    // Responde de inmediato en vez de esperar hasta 15 min a la próxima corrida del job.
    try {
      await procesarHiloAutorespuestaAprobado(threadId, chatId);
    } catch (error) {
      console.error(`[autorespuestaHiloCallbackHandler] Error respondiendo de inmediato tras aprobar el hilo ${threadId} (se reintenta en la próxima corrida):`, error);
    }
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}
