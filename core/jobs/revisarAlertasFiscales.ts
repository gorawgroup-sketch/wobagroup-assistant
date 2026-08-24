import { calcularProximasAlertas } from "../fiscal/calendario";
import { sendTelegramMessage } from "../telegram/client";

const VENTANA_DIAS = 3;

function describirCuando(diasParaVencer: number): string {
  if (diasParaVencer === 0) return "HOY";
  if (diasParaVencer === 1) return "mañana";
  return `en ${diasParaVencer} días`;
}

/**
 * Job diario: revisa /docs/calendario_fiscal.json y, si hay algún vencimiento
 * dentro de los próximos 3 días (incluyendo hoy), manda UN solo mensaje de
 * Telegram agrupando todos. Si no hay nada próximo, no manda nada. Solo
 * lectura y notificación — no escribe en ningún lado.
 */
export async function revisarAlertasFiscales(referenceDate: Date = new Date()): Promise<{
  alertasEnviadas: number;
}> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  if (!chatId) {
    console.error("[revisarAlertasFiscales] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { alertasEnviadas: 0 };
  }

  const alertas = calcularProximasAlertas(VENTANA_DIAS, referenceDate);

  if (alertas.length === 0) {
    console.log("[revisarAlertasFiscales] Sin vencimientos próximos, no se envía nada.");
    return { alertasEnviadas: 0 };
  }

  const lineas = alertas.map(
    (a) =>
      `• ${a.concepto} (${a.empresa}) — vence ${describirCuando(a.diasParaVencer)} ` +
      `(${a.fecha.toLocaleDateString("es-ES")})`
  );

  const texto = [`⚠️ Alertas fiscales próximas (${alertas.length}):`, "", ...lineas].join("\n");

  await sendTelegramMessage(chatId, texto);

  console.log(`[revisarAlertasFiscales] ${alertas.length} alerta(s) enviada(s) en un solo mensaje.`);
  return { alertasEnviadas: alertas.length };
}
