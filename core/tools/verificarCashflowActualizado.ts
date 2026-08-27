import { detectarNoRegistrados, type EmpresaCashflow } from "../jobs/revisarHoldedVsCashflow";
import { previousWeekRange, currentWeekRangeToDate, weekLabel, formatDateISO } from "../utils/isoWeek";
import type { ToolDefinition } from "./types";

const EMPRESAS: EmpresaCashflow[] = ["WOBA", "EWORKS"];

/**
 * A diferencia de consultar_cashflow_resumen (que solo lee los números ya
 * calculados en la hoja CASHFLOW), esta herramienta hace la comparación
 * real: trae los movimientos bancarios de Holded del período y los cruza
 * contra lo que YA está registrado en DATOS — exactamente la misma lógica
 * que usa el cron semanal (revisarHoldedVsCashflow), pero bajo demanda y
 * sin crear propuestas ni escribir nada. Nace de una corrección real: el
 * asistente respondía "está actualizado" leyendo solo el resumen, sin
 * verificar contra Holded — esta herramienta existe para que eso no vuelva
 * a pasar cuando pregunten específicamente si el cashflow "está al día".
 */
export const verificarCashflowActualizadoTool: ToolDefinition = {
  name: "verificar_cashflow_actualizado",
  description:
    "Verifica si el cashflow de WOBA y/o EWORKS está REALMENTE al día, comparando los movimientos " +
    "bancarios reales de Holded contra lo ya registrado en la hoja DATOS — no es un resumen de números, " +
    "hace la comparación real. Úsala cuando pregunten '¿está actualizado el cashflow?', '¿está al día?', " +
    "'¿falta algo por registrar?', o pidan comparar contra Holded. Para preguntas de 'cómo va el balance' " +
    "sin pedir verificación, usa mejor consultar_cashflow_resumen (más rápido, no cruza contra Holded). " +
    "Nunca escribe ni propone nada — solo reporta qué falta, si falta algo.",
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
        description:
          "'semana_actual' (por defecto) revisa lo que va de la semana en curso, de lunes a hoy — para " +
          "'¿está actualizado esta semana?'. 'semana_anterior' revisa la semana pasada completa (lunes a " +
          "domingo) — para '¿quedó bien cerrada la semana pasada?'.",
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
    let algoFalta = false;

    for (const empresa of empresas) {
      try {
        const candidatos = await detectarNoRegistrados(empresa, semanaLabel, desde, hasta);

        if (candidatos.length === 0) {
          partes.push(`✅ ${empresa}: al día — todos los movimientos bancarios de Holded en ${semanaLabel} (${desde} a ${hasta}) están registrados en el cashflow.`);
        } else {
          algoFalta = true;
          const lineas = candidatos
            .map(
              (c) =>
                `  • ${c.descripcion} — ${c.valorAbs.toFixed(2)} € (${c.esIngreso ? "abono" : "cargo"}${c.fecha ? `, ${c.fecha}` : ""})`
            )
            .join("\n");
          partes.push(`⚠️ ${empresa}: faltan ${candidatos.length} movimiento(s) de Holded por registrar en ${semanaLabel}:\n${lineas}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        partes.push(`⚠️ ${empresa}: no se pudo verificar (${message}).`);
      }
    }

    const encabezado = esSemanaAnterior
      ? `Verificación de ${semanaLabel} (semana anterior completa) contra Holded:`
      : `Verificación de ${semanaLabel} (lo que va de esta semana, hasta hoy) contra Holded:`;

    const pie = algoFalta
      ? "\nSi quieres que los registre, dímelo y te muestro cada uno con botón de aprobación (o espera al chequeo automático del viernes/lunes)."
      : "";

    return [encabezado, "", ...partes, pie].filter(Boolean).join("\n");
  },
};
