import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import {
  consumirPendienteEdicionCompraHolded,
  eliminarPendienteEdicionCompraHolded,
  obtenerPendienteEdicionCompraHolded,
} from "./pendienteEdicionCompraHoldedStore";
import { editarCompraHolded, EdicionCompraInciertaError, EdicionNoVerificadaError } from "./write";
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
  if (accion !== "edicioncompra_confirmar" && accion !== "edicioncompra_cancelar") {
    await answerCallbackQuerySafe(callback.id, "Acción de edición no reconocida.");
    return;
  }
  const pendiente =
    accion === "edicioncompra_cancelar"
      ? await consumirPendienteEdicionCompraHolded(id)
      : await obtenerPendienteEdicionCompraHolded(id);
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
    const resultado = await editarCompraHolded(pendiente.empresa, pendiente.purchaseId, pendiente.cambios, {
      idempotencyKey: `propuesta-edicion:${pendiente.id}`,
      proceso: "edicion_compra_aprobada",
    });
    await eliminarPendienteEdicionCompraHolded(pendiente.id).catch((error) =>
      console.error(
        "[edicionCompraHoldedCallbackHandler] La edición quedó verificada, pero no se pudo cerrar la propuesta:",
        error instanceof Error ? error.name : "Error"
      )
    );
    const totalDespues = typeof resultado.total === "number" ? resultado.total.toFixed(2) : String(resultado.total ?? "");
    // Hallazgo real de auditoría: esto mandaba "€" fijo sin importar la
    // moneda real del documento — inofensivo mientras editarCompraHolded
    // reseteaba todo a EUR en silencio (ver ese archivo), pero con ese bug ya
    // corregido, un gasto en USD ahora sí queda en USD en Holded y este
    // mensaje reportaría "€" de todas formas, reproduciendo en el chat la
    // misma confusión ("parece euros, es dólares") que el fix de fondo
    // elimina de Holded.
    const monedaDespues = (resultado.currency ?? "EUR").toUpperCase().trim();
    await editTelegramMessage(
      pendiente.chatId,
      pendiente.messageId,
      `✅ Editado en Holded — antes: ${pendiente.resumenAntes}\n` +
        `Ahora: ${totalDespues} ${monedaDespues}, doc "${resultado.document_number || "(sin número)"}" (id ${resultado.id} — mismo documento, no se recreó).`,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[edicionCompraHoldedCallbackHandler] Error editando la compra:", message);
    // EdicionNoVerificadaError significa que el PUT SÍ se envió y Holded
    // respondió 200 OK — el documento pudo haber cambiado, solo no de la
    // forma esperada. Nunca decir "no se tocó nada" en ese caso, sería falso.
    const notaEstado =
      error instanceof EdicionNoVerificadaError || error instanceof EdicionCompraInciertaError
        ? "La edición pudo haberse enviado a Holded. Wobi bloqueó cualquier repetición automática; revísala allí y conserva esta propuesta hasta que la reconciliación confirme el resultado."
        : "El documento original no se tocó, revísalo a mano si hace falta.";
    await editTelegramMessage(
      pendiente.chatId,
      pendiente.messageId,
      `⚠️ No pude confirmar la edición de "${pendiente.resumenAntes}" en Holded: ${message}\n\n${notaEstado}`,
      []
    );
  }
}
