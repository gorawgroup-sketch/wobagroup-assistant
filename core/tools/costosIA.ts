import { obtenerResumenCostos } from "../claude/costTracking";
import { obtenerRolUsuario } from "../telegram/authorizedUsersSheet";
import type { ToolDefinition } from "./types";

function inicioDelDia(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export const costosIATool: ToolDefinition = {
  name: "consultar_costos_sistema",
  description:
    "Consulta cuánto ha costado (en USD) el uso del modelo de IA del asistente en un periodo — hoy, " +
    "esta semana, este mes, o un número de días. Solo lo pueden consultar administradores. Úsala " +
    "cuando pregunten cuánto está gastando el sistema, el costo de operación, o algo similar.",
  input_schema: {
    type: "object",
    properties: {
      periodo: {
        type: "string",
        enum: ["hoy", "semana", "mes"],
        description: "Periodo a consultar. Por defecto 'mes' si se omite.",
      },
    },
  },
  handler: async (input, context) => {
    const rol = await obtenerRolUsuario(context?.chatId);
    if (rol !== "admin") {
      return "Esta consulta solo está disponible para administradores.";
    }

    const periodo = typeof input.periodo === "string" ? input.periodo : "mes";
    const ahora = new Date();
    const hoy = inicioDelDia(ahora);

    let desde: Date;
    if (periodo === "hoy") {
      desde = hoy;
    } else if (periodo === "semana") {
      desde = new Date(hoy);
      desde.setDate(desde.getDate() - 7);
    } else {
      desde = new Date(hoy);
      desde.setDate(desde.getDate() - 30);
    }

    const hasta = new Date(ahora.getTime() + 1000);
    const resumen = await obtenerResumenCostos(desde, hasta);

    if (resumen.llamadas === 0) {
      return `No hay registro de uso de IA en el periodo consultado (${periodo}).`;
    }

    return [
      `Costo de IA (${periodo}): $${resumen.costoUSD.toFixed(4)} USD`,
      `Llamadas a la API: ${resumen.llamadas}`,
      `Tokens de entrada: ${resumen.inputTokens.toLocaleString("es-ES")}`,
      `Tokens de salida: ${resumen.outputTokens.toLocaleString("es-ES")}`,
      `Modelo: claude-sonnet-4-6 ($3/1M entrada, $15/1M salida)`,
    ].join("\n");
  },
};
