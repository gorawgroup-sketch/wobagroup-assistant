import { leerConocimiento } from "../seguros/agente/conocimiento";
import { construirInformeSemanal } from "../seguros/informeSemanal";
import { listarPolizas } from "../seguros/polizaRegistroSheet";
import { formatDateLocal } from "../utils/dateFormat";
import { sendTelegramMessageExpandable } from "../telegram/client";

/**
 * Resumen semanal de Wobi Seguros (lunes 9:10): pagos sin confirmar, lo que espera a Carlos y los vencimientos y pagos de
 * los próximos 60 días. Sin IA. Si no hay nada, no escribe. Los avisos de eventos (vencimientos a 30 días, recibos
 * devueltos, cargos nuevos, correos) siguen siendo los de revisarAlertasSeguros y del vigilante.
 */
export async function informeSemanalSeguros(): Promise<{ enviado: boolean }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;
  if (!chatId) {
    console.error("[informeSemanalSeguros] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { enviado: false };
  }
  const [polizas, conocimiento] = await Promise.all([listarPolizas(), leerConocimiento()]);
  const informe = construirInformeSemanal({ hoy: formatDateLocal(new Date()), polizas, conocimiento });
  if (!informe) return { enviado: false };
  await sendTelegramMessageExpandable(chatId, informe.titulo, informe.cuerpo);
  console.log("[informeSemanalSeguros] resumen semanal enviado.");
  return { enviado: true };
}
