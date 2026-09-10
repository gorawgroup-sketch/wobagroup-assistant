import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { consumirPendienteRegistroManualCashflow } from "./pendienteRegistroManualCashflowStore";
import { registrarMovimientoEnSheet, registrarPendienteEnSheet, BLOQUES_SECCION_COMPARTIDA } from "./cashflowWrite";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[registroManualCashflowCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

/**
 * Botones de una propuesta de registro manual nuevo en cashflow ya creada (ver
 * proponerRegistroManualCashflowTool, core/tools/registrarManualCashflow.ts). Solo
 * "regmanualcf_confirmar" dispara la escritura real — "regmanualcf_cancelar" no escribe nada, pero está
 * protegida igual (mismo criterio que edicioncashflow_cancelar: se centraliza en superadmin la decisión
 * completa, no solo la que escribe).
 */
export async function handleRegistroManualCashflowCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");
  const pendiente = await consumirPendienteRegistroManualCashflow(id);
  if (!pendiente) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya se procesó).");
    return;
  }

  if (accion === "regmanualcf_cancelar") {
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    await editTelegramMessage(pendiente.chatId, pendiente.messageId, `❌ Cancelado — ${pendiente.resumen}`, []);
    return;
  }

  await answerCallbackQuerySafe(callback.id, "Registrando...");
  await editTelegramMessage(pendiente.chatId, pendiente.messageId, `🔄 Registrando en cashflow — ${pendiente.resumen}...`, []);

  try {
    const esSeccionCompartida = (BLOQUES_SECCION_COMPARTIDA as string[]).includes(pendiente.bloque);

    const resultado = esSeccionCompartida
      ? await registrarPendienteEnSheet({
          seccion: pendiente.bloque as "pagos_pendientes_alberto" | "deudas_pendientes",
          empresa: pendiente.empresa,
          cliente: pendiente.clienteOConcepto,
          semana: pendiente.semana,
          valor: pendiente.valor,
        })
      : await registrarMovimientoEnSheet({
          bloque: pendiente.bloque,
          cliente_o_concepto: pendiente.clienteOConcepto,
          proyecto: pendiente.proyecto,
          banco: pendiente.banco,
          semana: pendiente.semana ?? "",
          valor: pendiente.valor,
          empresa: pendiente.empresa,
        });

    if (!resultado.ok) {
      await editTelegramMessage(pendiente.chatId, pendiente.messageId, `⚠️ No pude confirmar el registro de "${pendiente.resumen}": ${resultado.mensaje}`, []);
      return;
    }

    await editTelegramMessage(pendiente.chatId, pendiente.messageId, `✅ Registrado en cashflow — ${pendiente.resumen} (${resultado.rango}).`, []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[registroManualCashflowCallbackHandler] Error registrando en el cashflow:", message);
    await editTelegramMessage(
      pendiente.chatId,
      pendiente.messageId,
      `⚠️ No pude confirmar el registro de "${pendiente.resumen}" en el cashflow: ${message}\n\nRevísalo a mano si hace falta.`,
      []
    );
  }
}
