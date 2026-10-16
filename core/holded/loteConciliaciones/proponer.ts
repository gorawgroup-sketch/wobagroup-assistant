import { resumenLote, type LoteConciliaciones } from "./model";

/**
 * Publica un lote de conciliaciones con su desglose completo y UN botón de aprobación («Conciliar los N pares») más «Cancelar».
 * Único punto de publicación (lo usa la herramienta del modelo). No escribe en Holded: solo el botón del superadministrador ejecuta el lote.
 */
export async function proponerLoteConciliaciones(chatId: number, l: LoteConciliaciones): Promise<void> {
  const { sendTelegramMessage, sendTelegramMessageWithButtons } = await import("../../telegram/client");
  const resumen = resumenLote(l);
  // Mostrar siempre el desglose completo, incluso cuando excede un mensaje de Telegram.
  for (let i = 0; i < resumen.length; i += 3000) await sendTelegramMessage(chatId, resumen.slice(i, i + 3000));
  await sendTelegramMessageWithButtons(chatId,
    `Lote ${l.id}: ¿confirmas conciliar estos ${l.incluidos.length} par(es) en ${l.empresa}? Se revalidan TODOS contra Holded antes de escribir el primero; ` +
    "se ejecutan de uno en uno verificando cada pago, y si uno falla el lote se detiene y se informa del avance real.",
    [[{ text: `✅ Conciliar los ${l.incluidos.length} pares`, callback_data: `loteconcil_si:${l.id}` }],
      [{ text: "❌ Cancelar", callback_data: `loteconcil_no:${l.id}` }]]);
}
