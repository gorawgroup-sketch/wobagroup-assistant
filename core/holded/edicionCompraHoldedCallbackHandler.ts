import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { consumirPendienteEdicionCompraHolded } from "./pendienteEdicionCompraHoldedStore";
import { editarCompraHolded, EdicionNoVerificadaError } from "./write";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[edicionCompraHoldedCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

/**
 * Botones de una propuesta de edición de compra ya creada en Holded (ver
 * proponerEdicionCompraHoldedTool, core/tools/editarCompraHolded.ts). Solo
 * "edicioncompra_confirmar" dispara el PUT real — "edicioncompra_cancelar"
 * no escribe nada, pero está protegida igual que "gasto_cancelar" (se
 * centraliza en superadmin la decisión completa, no solo la que escribe).
 */
export async function handleEdicionCompraHoldedCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");
  const pendiente = await consumirPendienteEdicionCompraHolded(id);
  if (!pendiente) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya se procesó).");
    return;
  }

  if (accion === "edicioncompra_cancelar") {
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    await editTelegramMessage(pendiente.chatId, pendiente.messageId, `❌ Cancelado — ${pendiente.resumenAntes}`, []);
    return;
  }

  await answerCallbackQuerySafe(callback.id, "Editando...");
  await editTelegramMessage(pendiente.chatId, pendiente.messageId, `🔄 Editando en Holded — ${pendiente.resumenAntes}...`, []);

  try {
    const resultado = await editarCompraHolded(pendiente.empresa, pendiente.purchaseId, pendiente.cambios);
    const totalDespues = typeof resultado.total === "number" ? resultado.total.toFixed(2) : String(resultado.total ?? "");
    await editTelegramMessage(
      pendiente.chatId,
      pendiente.messageId,
      `✅ Editado en Holded — antes: ${pendiente.resumenAntes}\n` +
        `Ahora: ${totalDespues} €, doc "${resultado.document_number || "(sin número)"}" (id ${resultado.id} — mismo documento, no se recreó).`,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[edicionCompraHoldedCallbackHandler] Error editando la compra:", message);
    // EdicionNoVerificadaError significa que el PUT SÍ se envió y Holded
    // respondió 200 OK — el documento pudo haber cambiado, solo no de la
    // forma esperada. Nunca decir "no se tocó nada" en ese caso, sería falso.
    const notaEstado =
      error instanceof EdicionNoVerificadaError
        ? "La edición SÍ se envió a Holded — revísalo ahí directo, no reintentes esta misma corrección sin comprobar antes."
        : "El documento original no se tocó, revísalo a mano si hace falta.";
    await editTelegramMessage(
      pendiente.chatId,
      pendiente.messageId,
      `⚠️ No pude confirmar la edición de "${pendiente.resumenAntes}" en Holded: ${message}\n\n${notaEstado}`,
      []
    );
  }
}
