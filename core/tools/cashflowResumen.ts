import { fetchResumenSemanas } from "../google/cashflowSheet";
import type { ToolDefinition } from "./types";

/**
 * Lee el resumen semanal ya calculado de la hoja CASHFLOW (balance inicial,
 * income, project expenses, general expenses, balance final). Pensado para
 * responder preguntas rápidas por Telegram.
 */
export const cashflowResumenTool: ToolDefinition = {
  name: "consultar_cashflow_resumen",
  seguraParaModoRapido: true,
  description:
    "Consulta el resumen semanal del cashflow del grupo (balance inicial, income, project expenses, " +
    "general expenses y balance final), leyendo los valores ya calculados de la hoja CASHFLOW. Úsala " +
    "para responder preguntas sobre el estado del cashflow en una semana o rango de semanas (formato " +
    "'S38'). Si no se especifica un rango, devuelve las últimas 4 semanas con datos.",
  input_schema: {
    type: "object",
    properties: {
      semana_desde: {
        type: "string",
        description: "Semana inicial del rango a consultar, formato 'S38'. Opcional.",
      },
      semana_hasta: {
        type: "string",
        description: "Semana final del rango a consultar, formato 'S40'. Opcional.",
      },
    },
  },
  handler: async (input) => {
    const semanas = await fetchResumenSemanas();
    const conDatos = semanas.filter((s) => s.balanceFinal.trim() !== "");

    const desde = typeof input.semana_desde === "string" ? input.semana_desde.trim().toUpperCase() : undefined;
    const hasta = typeof input.semana_hasta === "string" ? input.semana_hasta.trim().toUpperCase() : undefined;

    let seleccion: ResumenSemanaList;

    if (desde || hasta) {
      const idxDesde = desde ? conDatos.findIndex((s) => s.semana.toUpperCase() === desde) : 0;
      const idxHasta = hasta ? conDatos.findIndex((s) => s.semana.toUpperCase() === hasta) : conDatos.length - 1;

      if (idxDesde === -1 || idxHasta === -1) {
        return `No se encontró alguna de las semanas solicitadas (${desde ?? "?"} - ${hasta ?? "?"}) entre las semanas con datos disponibles.`;
      }

      seleccion = conDatos.slice(Math.min(idxDesde, idxHasta), Math.max(idxDesde, idxHasta) + 1);
    } else {
      seleccion = conDatos.slice(-4);
    }

    if (seleccion.length === 0) {
      return "No hay semanas con datos disponibles en el cashflow.";
    }

    return seleccion
      .map(
        (s) =>
          `${s.semana}: Balance inicial ${s.balanceInicial} | Income ${s.income} | ` +
          `Project expenses ${s.projectExpenses} | General expenses ${s.generalExpenses} | ` +
          `Balance final ${s.balanceFinal}`
      )
      .join("\n");
  },
};

type ResumenSemanaList = Awaited<ReturnType<typeof fetchResumenSemanas>>;
