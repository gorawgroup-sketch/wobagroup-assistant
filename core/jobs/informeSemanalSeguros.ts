import { leerConocimiento } from "../seguros/agente/conocimiento";
import { construirInformeSemanal } from "../seguros/informeSemanal";
import { leerPagosSeguros } from "../seguros/pagos/pagosStore";
import type { PagoSeguro } from "../seguros/pagos/tipos";
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
  // Sin el calendario de pagos el resumen sigue (los pagos salen de las notas del registro); no se cae por eso.
  let pagos: PagoSeguro[] | undefined;
  try { pagos = await leerPagosSeguros(); } catch (error) { console.error("[informeSemanalSeguros] No se pudo leer el calendario de pagos (se usan las notas):", error); }
  const informe = construirInformeSemanal({ hoy: formatDateLocal(new Date()), polizas, conocimiento, pagos });
  if (!informe) return { enviado: false };
  await sendTelegramMessageExpandable(chatId, informe.titulo, informe.cuerpo);
  console.log("[informeSemanalSeguros] resumen semanal enviado.");
  return { enviado: true };
}
