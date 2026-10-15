import { resumenPlan, type PlanConciliacion } from "./model";

/**
 * Muestra un plan de conciliación múltiple en el chat con su desglose completo y los botones de aprobación
 * («Confirmar conciliación múltiple» / «Cancelar»). Único punto de publicación: lo usan la herramienta del modelo,
 * la declaración de gastos sin soporte firmada (paso C) y el puente tras crear un gasto con cargos ya previstos.
 * No escribe en Holded: solo el botón del superadministrador ejecuta el lote.
 */
export async function proponerPlanConciliacionMultiple(chatId: number, p: PlanConciliacion, encabezado?: string): Promise<void> {
  const { sendTelegramMessage, sendTelegramMessageWithButtons } = await import("../../telegram/client");
  const resumen = `${encabezado ? `${encabezado}\n\n` : ""}${resumenPlan(p)}`;
  // Mostrar siempre el desglose completo, incluso cuando excede un mensaje de Telegram.
  for (let i = 0; i < resumen.length; i += 3000) await sendTelegramMessage(chatId, resumen.slice(i, i + 3000));
  await sendTelegramMessageWithButtons(chatId,
    `Plan ${p.id}: ¿confirmas vincular ${p.movimientos.length === 1 ? "este movimiento" : `estos ${p.movimientos.length} movimientos`} a la compra ${p.compra.numero || p.compra.id}${p.parcial ? " (conciliación parcial: el resto del saldo queda abierto)" : ""}? ` +
      "Se comprobarán otra vez los datos antes de escribir. Si un paso falla, se detendrá el lote y se informará del avance real.",
    [[{ text: "Confirmar conciliación múltiple", callback_data: `concilmulti_si:${p.id}` }],
      [{ text: "Cancelar", callback_data: `concilmulti_no:${p.id}` }]]);
}
