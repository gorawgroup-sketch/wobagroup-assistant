import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { consumirPendienteEdicionValorCashflow } from "./pendienteEdicionValorCashflowStore";
import { editarValorEnFilaCashflow } from "./cashflowWrite";
import { registrarFilaAprendida } from "./cashflowFilaAprendidaSheet";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[edicionValorCashflowCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

/**
 * Botones de una propuesta de edición de valor de cashflow ya creada (ver
 * proponerEdicionValorCashflowTool, core/tools/editarValorCashflow.ts). Solo
 * "edicioncashflow_confirmar" dispara la escritura real — "edicioncashflow_cancelar"
 * no escribe nada, pero está protegida igual (se centraliza en superadmin la
 * decisión completa, no solo la que escribe — mismo criterio que
 * edicioncompra_cancelar/gasto_cancelar).
 */
export async function handleEdicionValorCashflowCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");
  const pendiente = await consumirPendienteEdicionValorCashflow(id);
  if (!pendiente) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya se procesó).");
    return;
  }

  if (accion === "edicioncashflow_cancelar") {
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    await editTelegramMessage(pendiente.chatId, pendiente.messageId, `❌ Cancelado — ${pendiente.resumenAntes}`, []);
    return;
  }

  await answerCallbackQuerySafe(callback.id, "Editando...");
  await editTelegramMessage(pendiente.chatId, pendiente.messageId, `🔄 Editando cashflow — ${pendiente.resumenAntes}...`, []);

  try {
    const resultado = await editarValorEnFilaCashflow(pendiente.bloque, pendiente.fila, pendiente.valorActual, pendiente.valorNuevo);
    if (!resultado.ok) {
      // editarValorEnFilaCashflow ya distingue "el valor cambió mientras
      // tanto" de "la verificación post-escritura no coincidió" en su
      // propio mensaje — nunca decir "✅ Editado" cuando ok=false.
      await editTelegramMessage(pendiente.chatId, pendiente.messageId, `⚠️ No pude confirmar la edición de "${pendiente.resumenAntes}": ${resultado.mensaje}`, []);
      return;
    }
    // Pedido explícito de Carlos ("que la práctica te vaya dando velocidad"):
    // recuerda a qué fila real correspondió esta edición confirmada — ya no
    // se usa para saltarse el escaneo (ver el hallazgo de auditoría xhigh
    // junto a buscarFilaCashflowParaEditar en cashflowWrite.ts, que le quitó
    // ese atajo por ser inseguro con datos financieros reales), pero se deja
    // registrado como base para una versión futura y segura de esta
    // optimización. No crítico y no bloqueante — ni debe tumbar ni debe
    // demorar la confirmación de una edición que ya tuvo éxito, así que no
    // se espera (fire-and-forget).
    registrarFilaAprendida(pendiente.bloque, pendiente.clienteOConcepto, pendiente.semana, pendiente.fila).catch((error) =>
      console.error("[edicionValorCashflowCallbackHandler] Error registrando fila aprendida (no crítico):", error)
    );
    await editTelegramMessage(
      pendiente.chatId,
      pendiente.messageId,
      `✅ Editado en cashflow — antes: ${pendiente.resumenAntes}\nAhora: ${pendiente.valorNuevo.toFixed(2)} (${resultado.rango}).`,
      []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[edicionValorCashflowCallbackHandler] Error editando el cashflow:", message);
    await editTelegramMessage(
      pendiente.chatId,
      pendiente.messageId,
      `⚠️ No pude confirmar la edición de "${pendiente.resumenAntes}" en el cashflow: ${message}\n\nRevísalo a mano si hace falta.`,
      []
    );
  }
}
