import { retirarPreguntaCaducada } from "../telegram/preguntaCaducada";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { consumirPendienteLoteImpuestos, type OperacionLoteImpuestos } from "./pendienteLoteImpuestosStore";
import { editarImpuestoEnSheet, registrarImpuestoEnSheet } from "./cashflowImpuestos";

async function answerSafe(id: string, text?: string): Promise<void> {
  try { await answerCallbackQuery(id, text); } catch (error) { console.error("[loteImpuestos] No se pudo responder el callback (no crítico):", error); }
}

/** Botones de un lote de impuestos: «loteimpuestos_confirmar» ejecuta las operaciones, una a una y verificadas. */
export async function handleLoteImpuestosCallback(callback: TelegramCallbackQuery): Promise<void> {
  const [accion, id] = (callback.data ?? "").split(":");
  if (!id || (accion !== "loteimpuestos_confirmar" && accion !== "loteimpuestos_cancelar")) { await answerSafe(callback.id); return; }
  const lote = await consumirPendienteLoteImpuestos(id);
  if (!lote) { await retirarPreguntaCaducada(callback, "Este lote ya no está disponible (expiró o ya se procesó)."); return; }
  if (accion === "loteimpuestos_cancelar") {
    await answerSafe(callback.id, "Cancelado.");
    await editTelegramMessage(lote.chatId, lote.messageId, `❌ Cancelado — ${lote.titulo}`, []).catch(() => {});
    return;
  }
  await answerSafe(callback.id, "Aplicando…");
  await editTelegramMessage(lote.chatId, lote.messageId, `🔄 Aplicando en el cashflow — ${lote.titulo}…`, []).catch(() => {});
  const lineas: string[] = [];
  let ok = 0;
  for (const op of lote.operaciones) {
    try {
      const r = await ejecutar(op);
      lineas.push(`${r.ok ? "✅" : "⚠️"} ${op.descripcion}${r.ok ? ` (${r.rango})` : ` — ${r.mensaje}`}`);
      if (r.ok) ok++;
    } catch (error) {
      lineas.push(`⚠️ ${op.descripcion} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const resumen = `${ok === lote.operaciones.length ? "✅" : "⚠️"} ${lote.titulo}: ${ok} de ${lote.operaciones.length} aplicadas y verificadas.\n\n${lineas.join("\n")}`;
  // Telegram limita a 4096 caracteres; el cliente ya parte mensajes largos.
  await sendTelegramMessage(lote.chatId, resumen).catch((error) => console.error("[loteImpuestos] No se pudo informar el resultado:", error));
}

function ejecutar(op: OperacionLoteImpuestos) {
  return op.tipo === "alta" ? registrarImpuestoEnSheet(op.datos) : editarImpuestoEnSheet(op.datos);
}
