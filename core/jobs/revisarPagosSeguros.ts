import { prepararCalendarioPagos, marcarAvisosEnviados, type DepsCalendarioPagos } from "../seguros/pagos/calendarioPagos";
import { depsRealesCalendarioPagos } from "../seguros/pagos/depsReales";
import type { Informe } from "../seguros/vigilante/informe";
import { sendTelegramMessageExpandable } from "../telegram/client";

/**
 * Calendario de pagos de seguros (core/seguros/pagos/): cada día, sin IA, pone en el calendario de Carlos el evento de cada pago (3 días antes),
 * y cuando un pago está a 1-3 días avisa por Telegram con la comprobación de saldo de su cuenta de cargo. A las 8:55: después del vigilante
 * (8:35, que confirma o devuelve lo ya cobrado) y de los avisos de las 8:50. Calla si no toca avisar nada.
 *
 * Entrega «al menos una vez»: el aviso se marca como enviado solo después de que Telegram lo acepte; si falla, se repite al día siguiente.
 */
export async function revisarPagosSeguros(
  deps: DepsCalendarioPagos = depsRealesCalendarioPagos(),
  enviar: (chatId: number, informe: Informe) => Promise<unknown> = (chatId, informe) => sendTelegramMessageExpandable(chatId, informe.titulo, informe.cuerpo)
): Promise<{ avisado: boolean }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;
  if (!chatId) {
    console.error("[revisarPagosSeguros] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar: no se revisa nada.");
    return { avisado: false };
  }

  const r = await prepararCalendarioPagos(deps);
  let avisado = false;
  if (r.informe) {
    try {
      await enviar(chatId, r.informe);
      await marcarAvisosEnviados(deps, r.avisos);
      avisado = true;
    } catch (error) {
      console.error("[revisarPagosSeguros] No se pudo entregar el aviso de pagos (se repite mañana):", error);
    }
  }
  for (const advertencia of r.advertencias) console.warn(`[revisarPagosSeguros] ${advertencia}`);
  console.log(
    `[revisarPagosSeguros] ${r.hoy}: ${r.eventosCreados} evento(s) de calendario creado(s), ${r.eventosRetirados} retirado(s), ${r.avisos.length} pago(s) a avisar; ${avisado ? "aviso enviado" : "sin aviso"}.`
  );
  return { avisado };
}
