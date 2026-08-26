import { obtenerResumenCostos, obtenerCostoPorDia } from "../claude/costTracking";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";

// Si el costo de ayer supera este múltiplo del promedio de los 7 días
// anteriores, se marca como gasto inusual en el resumen.
const UMBRAL_ANOMALIA = 2;

/**
 * Job diario: manda a todos los admins un resumen del costo de IA de ayer
 * (y del mes en curso), y avisa si el gasto de ayer fue inusualmente alto
 * comparado con el promedio de los últimos 7 días. Solo lectura — no
 * escribe ni modifica nada, solo informa.
 */
export async function revisarCostosIA(referenceDate: Date = new Date()): Promise<{ costoAyerUSD: number }> {
  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error("[revisarCostosIA] No hay ningún admin registrado, no se puede notificar.");
    return { costoAyerUSD: 0 };
  }

  const hoy = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const ayerInicio = new Date(hoy);
  ayerInicio.setDate(ayerInicio.getDate() - 1);

  const [resumenAyer, resumenMes, costosPor7Dias] = await Promise.all([
    obtenerResumenCostos(ayerInicio, hoy),
    obtenerResumenCostos(new Date(hoy.getFullYear(), hoy.getMonth(), 1), new Date(hoy.getTime() + 1)),
    obtenerCostoPorDia(7, hoy),
  ]);

  if (resumenAyer.llamadas === 0) {
    console.log("[revisarCostosIA] Sin uso de IA ayer, no se envía nada.");
    return { costoAyerUSD: 0 };
  }

  const promedio7Dias = costosPor7Dias.reduce((a, b) => a + b, 0) / (costosPor7Dias.length || 1);
  const esAnomalia = promedio7Dias > 0 && resumenAyer.costoUSD > promedio7Dias * UMBRAL_ANOMALIA;

  const lineas = [
    `📊 *Costo de IA — ayer*`,
    `$${resumenAyer.costoUSD.toFixed(4)} USD (${resumenAyer.llamadas} llamadas, ` +
      `${resumenAyer.inputTokens.toLocaleString("es-ES")} tokens entrada / ` +
      `${resumenAyer.outputTokens.toLocaleString("es-ES")} salida)`,
    ``,
    `Promedio últimos 7 días: $${promedio7Dias.toFixed(4)} USD/día`,
    `Acumulado este mes: $${resumenMes.costoUSD.toFixed(4)} USD (${resumenMes.llamadas} llamadas)`,
  ];

  if (esAnomalia) {
    lineas.push(
      ``,
      `⚠️ El gasto de ayer fue más de ${UMBRAL_ANOMALIA}x el promedio reciente — revisa si hubo un uso ` +
        `fuera de lo normal.`
    );
  }

  const texto = lineas.join("\n");

  for (const admin of admins) {
    await sendTelegramMessage(admin.userId, texto).catch((error) =>
      console.error(`[revisarCostosIA] Error notificando a admin ${admin.userId}:`, error)
    );
  }

  return { costoAyerUSD: resumenAyer.costoUSD };
}
