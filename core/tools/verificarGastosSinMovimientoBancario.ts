import { detectarSinMovimientoBancario, type EmpresaCashflow } from "../jobs/revisarHoldedVsCashflow";
import { previousWeekRange, currentWeekRangeToDate, weekLabel, formatDateISO } from "../utils/isoWeek";
import type { ToolDefinition } from "./types";

const EMPRESAS: EmpresaCashflow[] = ["WOBA", "EWORKS"];

/**
 * Dirección inversa de verificar_cashflow_actualizado: en vez de "¿qué hay
 * en el banco que falta registrar?", responde "¿qué gasto está registrado
 * en el cashflow de esta semana que el banco todavía NO refleja como una
 * salida de dinero real?" — cruce de info entre bancos/cuentas y cashflow,
 * en el sentido que de verdad importa cuando el dinero sigue en la cuenta.
 */
export const verificarGastosSinMovimientoBancarioTool: ToolDefinition = {
  name: "verificar_gastos_sin_movimiento_bancario",
  description:
    "Compara los gastos ya registrados en el cashflow de esta semana (o la anterior) de WOBA/EWORKS " +
    "contra los movimientos bancarios REALES de Holded, y reporta cuáles NO tienen un movimiento " +
    "bancario que los respalde — es decir, el dinero todavía no ha salido de la cuenta aunque esté " +
    "anotado como gasto. Úsala cuando pregunten algo como 'qué pagos del cashflow no se han hecho de " +
    "verdad', 'qué gastos siguen sin salir del banco', o cualquier cruce entre cashflow y bancos en ESE " +
    "sentido. Para el sentido contrario (qué hay en el banco que falta registrar en el cashflow), usa " +
    "verificar_cashflow_actualizado. Nunca escribe ni propone nada, solo reporta.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
        description: "Empresa a verificar. Si no se indica, verifica ambas.",
      },
      periodo: {
        type: "string",
        enum: ["semana_actual", "semana_anterior"],
        description: "'semana_actual' (por defecto) o 'semana_anterior' (completa, lunes a domingo).",
      },
    },
  },
  handler: async (input) => {
    const empresaFiltro = input.empresa as EmpresaCashflow | undefined;
    if (empresaFiltro && empresaFiltro !== "WOBA" && empresaFiltro !== "EWORKS") {
      return "Error: 'empresa' debe ser WOBA o EWORKS (Footprint no tiene cashflow en Sheets).";
    }
    const empresas = empresaFiltro ? [empresaFiltro] : EMPRESAS;

    const esSemanaAnterior = input.periodo === "semana_anterior";
    const referencia = new Date();
    const { start, end } = esSemanaAnterior ? previousWeekRange(referencia) : currentWeekRangeToDate(referencia);
    const semanaLabel = weekLabel(start);
    const desde = formatDateISO(start);
    const hasta = formatDateISO(end);

    const partes: string[] = [];
    let algoPendiente = false;

    for (const empresa of empresas) {
      try {
        const candidatos = await detectarSinMovimientoBancario(empresa, semanaLabel, desde, hasta);

        if (candidatos.length === 0) {
          partes.push(`✅ ${empresa}: todos los gastos registrados en el cashflow de ${semanaLabel} ya tienen su salida real en el banco.`);
        } else {
          algoPendiente = true;
          const lineas = candidatos
            .map((c) => `  • ${c.descripcion} — ${c.valorAbs.toFixed(2)} € (${c.categoria})`)
            .join("\n");
          partes.push(
            `⚠️ ${empresa}: ${candidatos.length} gasto(s) registrado(s) en el cashflow de ${semanaLabel} SIN salida real en el banco todavía:\n${lineas}`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        partes.push(`⚠️ ${empresa}: no se pudo verificar (${message}).`);
      }
    }

    const encabezado = esSemanaAnterior
      ? `Gastos de ${semanaLabel} (semana anterior completa) sin movimiento bancario real:`
      : `Gastos de ${semanaLabel} (lo que va de esta semana) sin movimiento bancario real:`;

    const pie = algoPendiente
      ? "\nEsto no significa que estén mal registrados — puede que el pago siga en tránsito o programado para más adelante. Solo confirma que el banco aún no lo refleja."
      : "";

    return [encabezado, "", ...partes, pie].filter(Boolean).join("\n");
  },
};
