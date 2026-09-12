import { obtenerAnalisisCostosDiario } from "../claude/costTracking";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { obtenerEstadoConexiones } from "../cerebro/conexiones";
import { diagnosticarMemoriaConversacional } from "../claude/conversationStore";
import { cargarConfiguracionPoliticaApi } from "../ai/policy";

// Si el costo de ayer supera este múltiplo del promedio de los 7 días
// anteriores, se marca como gasto inusual en el resumen. Exportado para que
// el endpoint /api/cerebro/estado calcule el mismo umbral dinámico sin
// duplicar el número.
export const UMBRAL_ANOMALIA = 2;

/**
 * Control diario determinista: costo/anomalías, loops, conectividad,
 * permisos y memoria. No invoca ningún modelo. Solo lee los servicios y
 * notifica si hubo consumo o existe algo accionable.
 */
/**
 * Pedido explícito de Carlos: "sí sigue controlando el tema de costos todos los días" — a
 * diferencia del resto de avisos informativos (que se saltan en fin de semana), este SÍ corre los 7
 * días: sirve para detectar un gasto de IA anormal (posible bug/loop consumiendo de más) el mismo
 * día que pasa, no el lunes siguiente — mismo criterio que las alertas fiscales/de plazos reales.
 */
export async function revisarCostosIA(referenceDate: Date = new Date()): Promise<{ costoAyerUSD: number; problemas: number }> {
  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error("[revisarCostosIA] No hay ningún admin registrado, no se puede notificar.");
    return { costoAyerUSD: 0, problemas: 1 };
  }

  const [analisisCostos, conexiones, memoria] = await Promise.all([
    obtenerAnalisisCostosDiario(referenceDate, UMBRAL_ANOMALIA),
    obtenerEstadoConexiones(true).catch(() => []),
    diagnosticarMemoriaConversacional(),
  ]);

  const resumenAyer = analisisCostos.ayer;
  const resumenMes = analisisCostos.mesActual;
  const promedio7Dias = analisisCostos.promedio7DiasPreviosUSD;
  const esAnomalia = analisisCostos.esAnomaliaAyer;
  const configApi = cargarConfiguracionPoliticaApi();
  const conexionesCaidas = conexiones.filter((c) => !c.ok);
  const problemas: string[] = [];
  if (esAnomalia) problemas.push(`gasto > ${UMBRAL_ANOMALIA}x el promedio reciente`);
  if (conexiones.length === 0) problemas.push("no se pudo completar el chequeo de conexiones");
  if (conexionesCaidas.length > 0) problemas.push(`servicios caídos/permisos: ${conexionesCaidas.map((c) => c.nombre).join(", ")}`);
  if (!memoria.ok) problemas.push(`memoria no íntegra (${memoria.filasCorruptas} fila(s) corrupta(s))`);
  if (analisisCostos.ejecucionesConMuchasLlamadasAyer > 0) {
    problemas.push(`${analisisCostos.ejecucionesConMuchasLlamadasAyer} ejecución(es) con posibles repeticiones`);
  }
  if (configApi.modo === "allowlist") {
    if (configApi.limiteDiarioUSD > 0 && resumenAyer.gastoRealApiUSD >= configApi.limiteDiarioUSD) {
      problemas.push("límite diario de API alcanzado");
    }
    if (configApi.limiteMensualUSD > 0 && resumenMes.gastoRealApiUSD >= configApi.limiteMensualUSD) {
      problemas.push("límite mensual de API alcanzado");
    }
  }

  if (resumenAyer.llamadas === 0 && problemas.length === 0) {
    console.log("[revisarCostosIA] Control diario OK; sin uso de IA ayer, no se envía nada.");
    return { costoAyerUSD: 0, problemas: 0 };
  }

  const lineas = [
    `📊 *Costo de IA — ayer*`,
    `$${resumenAyer.gastoRealApiUSD.toFixed(4)} USD reales de API (${resumenAyer.llamadas} llamadas, ` +
      `${resumenAyer.inputTokens.toLocaleString("es-ES")} tokens entrada / ` +
      `${resumenAyer.outputTokens.toLocaleString("es-ES")} salida)`,
    ``,
    `Promedio últimos 7 días: $${promedio7Dias.toFixed(4)} USD/día`,
    `Acumulado API este mes: $${resumenMes.gastoRealApiUSD.toFixed(4)} USD (${resumenMes.llamadas} llamadas)`,
    `Valor equivalente cubierto por suscripción este mes: $${resumenMes.costoEquivalenteSuscripcionUSD.toFixed(4)} USD`,
    `Caché ayer: ${resumenAyer.cacheReadTokens.toLocaleString("es-ES")} tokens reutilizados / ` +
      `${resumenAyer.cacheCreationTokens.toLocaleString("es-ES")} creados; ahorro neto estimado ` +
      `$${resumenAyer.ahorroNetoCacheUSD.toFixed(4)} USD`,
    `Política API: ${configApi.killSwitch ? "kill switch activo" : configApi.modo}`,
    `Memoria: ${memoria.ok ? "íntegra" : "requiere revisión"} (${memoria.filas} conversaciones, ${memoria.filasVencidas} vencidas)`,
    `Servicios: ${conexionesCaidas.length === 0 ? "operativos" : `${conexionesCaidas.length} con error`}`,
  ];

  if (problemas.length > 0) {
    lineas.push(
      ``,
      `⚠️ Requiere atención:`,
      ...problemas.map((p) => `• ${p}`)
    );
  }

  const texto = lineas.join("\n");

  for (const admin of admins) {
    await sendTelegramMessage(admin.userId, texto).catch((error) =>
      console.error(`[revisarCostosIA] Error notificando a admin ${admin.userId}:`, error)
    );
  }

  return { costoAyerUSD: resumenAyer.gastoRealApiUSD, problemas: problemas.length };
}
