import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { obtenerAccionPorId, marcarAccionCancelada } from "./accionesProgramadasStore";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[accionesProgramadasCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/** Único botón de este flujo: "❌ Cancelar programación" (accprog_cancelar:<id>). */
export async function handleAccionProgramadaCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  if (!data || !chatId || !messageId) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [, id] = data.split(":");
  const accion = await obtenerAccionPorId(id);

  if (!accion || accion.estado !== "pendiente") {
    await answerCallbackQuerySafe(callback.id, "Esta programación ya no está disponible (ya se ejecutó, se canceló, o expiró).");
    return;
  }

  await marcarAccionCancelada(id);
  await answerCallbackQuerySafe(callback.id, "Cancelado.");
  await editTelegramMessage(chatId, messageId, `❌ Programación cancelada — ${accion.contexto}`, []);
}
