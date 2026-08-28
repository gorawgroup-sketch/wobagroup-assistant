import { fetchDetalleRegistros } from "../google/cashflowSheet";
import { mondayOf } from "../utils/isoWeek";
import { formatDateLocal } from "../utils/dateFormat";
import { VENTANA_ALERTA_DIAS } from "../fiscal/calendario";
import { sendTelegramMessage } from "../telegram/client";

function describirCuando(diasParaVencer: number): string {
  if (diasParaVencer === 0) return "HOY";
  if (diasParaVencer === 1) return "mañana";
  return `en ${diasParaVencer} días`;
}

/**
 * Reconstruye el lunes de una etiqueta "S43" probando el año anterior, el
 * actual y el siguiente, y se queda con el que caiga MÁS CERCA de `hoy` —
 * a propósito, distinto de lunesDeEtiquetaSemana (core/utils/isoWeek.ts),
 * que asume "año actual salvo que el número sea mucho mayor al de hoy" para
 * reconstruir semanas RECIENTES ya pasadas. Aplazamiento Impuestos son
 * planes de pago que legítimamente miran varios meses hacia adelante (ej.
 * S39→S43→S47→S52→S03→S07, un mismo plan cruzando fin de año) — con el
 * heurístico de lunesDeEtiquetaSemana, una semana baja (S03) cerca de fin
 * de año se interpretaría como "ya pasó hace meses" en vez de "es el
 * S03 del año que viene, ya casi", y la alerta nunca se dispararía. Probar
 * los 3 años y quedarse con el más cercano evita esa trampa en ambos
 * sentidos.
 */
function fechaMasCercanaParaSemana(semanaLabel: string, hoy: Date): Date | null {
  const match = /^S(\d{1,2})$/i.exec(semanaLabel.trim());
  if (!match) return null;
  const numeroSemana = parseInt(match[1], 10);
  if (numeroSemana < 1 || numeroSemana > 53) return null;

  let mejor: Date | null = null;
  let mejorDistancia = Infinity;

  for (const anio of [hoy.getFullYear() - 1, hoy.getFullYear(), hoy.getFullYear() + 1]) {
    const lunesSemana1 = mondayOf(new Date(anio, 0, 4));
    const candidato = new Date(lunesSemana1);
    candidato.setDate(candidato.getDate() + (numeroSemana - 1) * 7);

    const distancia = Math.abs(candidato.getTime() - hoy.getTime());
    if (distancia < mejorDistancia) {
      mejorDistancia = distancia;
      mejor = candidato;
    }
  }

  return mejor;
}

/**
 * Job diario: revisa la columna "Aplazamiento Impuestos por Pagar" de la
 * hoja DATOS (categoría APLAZAMIENTO_IMPUESTOS, columnas AC:AE) y avisa
 * cuando la semana registrada de una fila cae dentro de la MISMA ventana de
 * aviso que ya usa revisarAlertasFiscales para el calendario fiscal
 * (VENTANA_ALERTA_DIAS, hoy 2 días) — un mensaje individual por fila, no un
 * resumen agrupado, mismo criterio que el resto de alertas fiscales para
 * poder rastrear cada pago por separado. Pedido explícito de Carlos: esta
 * columna hoy NO tenía ninguna alerta conectada.
 *
 * A diferencia del calendario fiscal (fechas exactas por tipo de
 * recurrencia), aquí solo hay una SEMANA (ej. "S43") — la fecha de
 * vencimiento se aproxima al lunes de esa semana (fechaMasCercanaParaSemana,
 * arriba). Filas sin semana asignada (todavía no se sabe cuándo) se
 * ignoran, no generan alerta — no hay fecha que comparar.
 */
export async function revisarAplazamientoImpuestos(referenceDate: Date = new Date()): Promise<{ alertasEnviadas: number }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  if (!chatId) {
    console.error("[revisarAplazamientoImpuestos] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { alertasEnviadas: 0 };
  }

  const registros = (await fetchDetalleRegistros()).filter(
    (r) => r.categoria === "APLAZAMIENTO_IMPUESTOS" && r.semana.trim()
  );

  const hoyNorm = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());

  let alertasEnviadas = 0;

  for (const registro of registros) {
    const fechaVencimiento = fechaMasCercanaParaSemana(registro.semana, hoyNorm);
    if (!fechaVencimiento) continue; // etiqueta de semana no reconocible — no se adivina la fecha

    const diasParaVencer = Math.round((fechaVencimiento.getTime() - hoyNorm.getTime()) / 86_400_000);
    if (diasParaVencer < 0 || diasParaVencer > VENTANA_ALERTA_DIAS) continue;

    const concepto = registro.concepto || "(sin concepto)";
    const texto =
      `💰 *Aplazamiento de impuestos* — ${concepto} — vence ${describirCuando(diasParaVencer)} ` +
      `(semana ${registro.semana}, aprox. ${formatDateLocal(fechaVencimiento)}) — ${registro.valor}`;

    try {
      await sendTelegramMessage(chatId, texto);
      alertasEnviadas++;
    } catch (error) {
      console.error("[revisarAplazamientoImpuestos] Error enviando alerta:", error);
    }
  }

  console.log(`[revisarAplazamientoImpuestos] ${alertasEnviadas} alerta(s) enviada(s).`);
  return { alertasEnviadas };
}
