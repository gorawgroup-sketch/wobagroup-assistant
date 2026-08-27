import { calcularProximasAlertas } from "../fiscal/calendario";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { formatDateLocal } from "../utils/dateFormat";

function describirCuando(diasParaVencer: number): string {
  if (diasParaVencer === 0) return "HOY";
  if (diasParaVencer === 1) return "mañana";
  return `en ${diasParaVencer} días`;
}

/**
 * Job diario: revisa /docs/calendario_fiscal.json y, si hay algún
 * vencimiento dentro de su ventana de aviso (2 días para TODAS las entradas
 * por igual, exacto o aproximado — ver VENTANA_ALERTA_DIAS en
 * fiscal/calendario.ts), manda un mensaje INDIVIDUAL por cada una — nunca
 * un resumen agrupado. Como el job corre una vez al día, un mismo pago
 * genera 3 mensajes distintos en 3 días consecutivos (a 2 días, a 1 día, y
 * el mismo día), pedido explícito para poder rastrear cada pago por
 * separado en vez de un bloque de texto con todos juntos.
 * - las entradas SIN empresaHolded (monto desconocido, o aplican a varias
 *   empresas) mandan un mensaje individual simple, informativo.
 * - las entradas CON empresaHolded (candidatas a proponerse en Holded, y en
 *   cashflow también si es WOBA/EWORKS — Footprint no tiene cashflow en
 *   Sheets) mandan su mensaje individual con botón "💰 Indicar monto y
 *   registrar" — nunca escribe nada por sí solo, solo abre el flujo de
 *   confirmación (ver core/fiscal/pagoRecurrenteCallbackHandler.ts).
 */
export async function revisarAlertasFiscales(referenceDate: Date = new Date()): Promise<{
  alertasEnviadas: number;
}> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  if (!chatId) {
    console.error("[revisarAlertasFiscales] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { alertasEnviadas: 0 };
  }

  const alertas = calcularProximasAlertas(referenceDate);

  if (alertas.length === 0) {
    console.log("[revisarAlertasFiscales] Sin vencimientos próximos, no se envía nada.");
    return { alertasEnviadas: 0 };
  }

  const accionables = alertas.filter((a) => a.id && a.empresaHolded);
  const informativas = alertas.filter((a) => !(a.id && a.empresaHolded));

  for (const a of informativas) {
    const texto =
      `⚠️ *${a.concepto}* (${a.empresa}, ${a.tipo}) — vence ${describirCuando(a.diasParaVencer)} ` +
      `(${formatDateLocal(a.fecha)})`;
    await sendTelegramMessage(chatId, texto);
  }

  for (const a of accionables) {
    const tieneCashflow = a.empresaHolded === "WOBA" || a.empresaHolded === "EWORKS";
    const texto = [
      `⚠️ *${a.concepto}* (${a.empresa}, ${a.tipo}) — vence ${describirCuando(a.diasParaVencer)} (${formatDateLocal(a.fecha)})`,
      a.proveedor ? `Proveedor conocido: ${a.proveedor}` : "",
      tieneCashflow
        ? `¿Quieres que lo registre en Holded (como gasto) y en el cashflow?`
        : `¿Quieres que lo registre en Holded (como gasto)? Footprint no tiene cashflow en Sheets, así que solo se escribe ahí.`,
    ]
      .filter(Boolean)
      .join("\n");

    await sendTelegramMessageWithButtons(chatId, texto, [
      [{ text: "💰 Indicar monto y registrar", callback_data: `recpago_indicar:${a.id}` }],
    ]);
  }

  console.log(
    `[revisarAlertasFiscales] ${informativas.length} mensaje(s) informativo(s) individual(es), ${accionables.length} accionable(s) con botón.`
  );
  return { alertasEnviadas: alertas.length };
}
