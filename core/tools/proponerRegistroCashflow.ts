import { detectarNoRegistrados, enviarPropuestaCandidato, type EmpresaCashflow } from "../jobs/revisarHoldedVsCashflow";
import { previousWeekRange, currentWeekRangeToDate, weekLabel, formatDateISO } from "../utils/isoWeek";
import type { ToolDefinition } from "./types";

const EMPRESAS: EmpresaCashflow[] = ["WOBA", "EWORKS"];

/**
 * A diferencia de verificar_cashflow_actualizado (que solo REPORTA qué
 * falta), esta herramienta además dispara el flujo real de aprobación: por
 * cada movimiento de Holded sin registrar, manda un mensaje con botones de
 * categoría (mismo mecanismo que ya usa el chequeo automático del viernes/
 * lunes, ver revisarHoldedVsCashflow.ts) para que el usuario elija dónde va
 * y lo apruebe con un toque — bajo demanda, sin esperar al próximo cron.
 * Nunca escribe nada ella misma: solo crea la propuesta y manda los
 * botones, la escritura real ocurre en el callback_query cf_approve
 * (gateado a superadmin, igual que el resto de escrituras sensibles).
 */
export const proponerRegistroCashflowTool: ToolDefinition = {
  name: "proponer_registro_cashflow",
  description:
    "Compara los movimientos bancarios reales de Holded contra el cashflow y, por cada uno que falte, " +
    "manda un mensaje CON BOTONES para elegir la categoría y aprobarlo — a diferencia de " +
    "verificar_cashflow_actualizado (que solo reporta texto), esta SÍ dispara el flujo de aprobación real. " +
    "Úsala cuando el usuario pida explícitamente registrar/actualizar/agregar lo que falta, o cuando " +
    "confirme que sí quiere verlos con botón tras una verificación. No la uses solo para 'revisar' o " +
    "'consultar' si falta algo — para eso usa verificar_cashflow_actualizado primero.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
        description: "Empresa a proponer. Si no se indica, propone de ambas.",
      },
      periodo: {
        type: "string",
        enum: ["semana_actual", "semana_anterior"],
        description: "'semana_actual' (por defecto) revisa lo que va de la semana en curso. 'semana_anterior' revisa la semana pasada completa.",
      },
    },
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) {
      return "Error: no se pudo determinar el chat para mandar las propuestas.";
    }

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
    let totalPropuestas = 0;

    for (const empresa of empresas) {
      try {
        const candidatos = await detectarNoRegistrados(empresa, semanaLabel, desde, hasta);

        if (candidatos.length === 0) {
          partes.push(`✅ ${empresa}: no falta nada por proponer en ${semanaLabel}.`);
          continue;
        }

        let enviadas = 0;
        for (const candidato of candidatos) {
          const ok = await enviarPropuestaCandidato(chatId, candidato, semanaLabel, false);
          if (ok) enviadas++;
        }
        totalPropuestas += enviadas;
        partes.push(`📋 ${empresa}: te mandé ${enviadas} propuesta(s) con botones arriba, para ${semanaLabel}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        partes.push(`⚠️ ${empresa}: no se pudo proponer (${message}).`);
      }
    }

    if (totalPropuestas === 0) {
      return partes.join("\n");
    }

    return [
      ...partes,
      "",
      "Revisa cada mensaje de arriba: elige la categoría con el botón correspondiente, o \"❌ Ignorar\" si no aplica.",
    ].join("\n");
  },
};
