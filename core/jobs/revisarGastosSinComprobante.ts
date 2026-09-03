import { buscarGastosSinComprobante } from "../holded/write";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { formatDateLocal } from "../utils/dateFormat";
import type { Empresa } from "../holded/client";

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];
const DIAS_HACIA_ATRAS = 7;

/**
 * Job diario: pedido explícito de Carlos, tras un caso real (un gasto de
 * Uber Colombia se creó en Holded sin su comprobante — el archivo local se
 * perdió en un redeploy de Railway antes de poder adjuntarlo, y el aviso de
 * error en el chat fue el único rastro) — "no hay gastos en la contabilidad
 * que puedan ser creados sin soporte, es ilegal". El reintento automático
 * desde Gmail (ver core/gmail/reDescargarAdjunto.ts) resuelve la mayoría de
 * estos casos en el momento, pero no todos (ej. un archivo subido por
 * Telegram sin ningún origen de Gmail al que volver, o el propio Gmail
 * inalcanzable) — así que además de reintentar en el momento, esto revisa
 * activamente cada día que ningún gasto reciente se haya quedado sin
 * comprobante, en vez de depender de que alguien recuerde preguntarlo.
 * Solo avisa si encuentra algo (silencio = todo bien, mismo criterio que el
 * resto de los crons de este proyecto) — pero a diferencia de un aviso
 * único que puede perderse en el chat, este se repite todos los días
 * mientras el gasto siga sin comprobante, hasta que se resuelva a mano.
 */
export async function revisarGastosSinComprobante(): Promise<{ sinComprobante: number }> {
  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error("[revisarGastosSinComprobante] No hay ningún admin registrado, no se puede notificar.");
    return { sinComprobante: 0 };
  }

  const hasta = new Date();
  const desde = new Date(hasta.getTime() - DIAS_HACIA_ATRAS * 24 * 60 * 60 * 1000);
  const desdeTxt = formatDateLocal(desde);
  const hastaTxt = formatDateLocal(hasta);

  const porEmpresa: { empresa: Empresa; lineas: string[] }[] = [];

  for (const empresa of EMPRESAS) {
    try {
      const { sinComprobante } = await buscarGastosSinComprobante(empresa, desdeTxt, hastaTxt);
      if (sinComprobante.length > 0) {
        porEmpresa.push({
          empresa,
          lineas: sinComprobante.map((g) => {
            const responsable = g.tags.length > 0 ? ` — posible responsable/etiqueta: ${g.tags.join(", ")}` : "";
            return `  • ${g.contactName} — ${g.total.toFixed(2)} € (${g.fecha}) — ${g.descripcion}${responsable}`;
          }),
        });
      }
    } catch (error) {
      console.error(`[revisarGastosSinComprobante] Error consultando ${empresa} (no crítico, sigue con las demás):`, error);
    }
  }

  const total = porEmpresa.reduce((acc, e) => acc + e.lineas.length, 0);
  if (total === 0) {
    console.log("[revisarGastosSinComprobante] Todos los gastos recientes tienen comprobante, no se envía nada.");
    return { sinComprobante: 0 };
  }

  const bloques = porEmpresa.map((e) => `${e.empresa}:\n${e.lineas.join("\n")}`).join("\n\n");
  const texto = [
    `⚠️ ${total} gasto(s) de los últimos ${DIAS_HACIA_ATRAS} días sin comprobante adjunto — esto se repite todos los días hasta que se resuelvan:`,
    "",
    bloques,
    "",
    "Sube el comprobante a mano en Holded, o pide en el chat que se busque y adjunte de nuevo si viene de un correo.",
  ].join("\n");

  for (const admin of admins) {
    try {
      await sendTelegramMessage(admin.userId, texto);
    } catch (error) {
      console.error(`[revisarGastosSinComprobante] Error notificando a admin ${admin.userId}:`, error);
    }
  }

  return { sinComprobante: total };
}
