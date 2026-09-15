import { descartarRecomendacionControlDiario } from "../cerebro/controlDiarioDescartesStore";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos: poder pedirle a Wobi, en la misma conversación donde investigó una
 * recomendación del Diagnóstico Diario, que la obvie — "que el sistema haga todo lo necesario
 * automáticamente" en vez de tener que ir a Sheets a mano. Úsala SOLO después de investigar de verdad
 * con datos reales (nunca a ciegas sobre el resumen) y de que el usuario confirme explícitamente que
 * quiere descartarla — nunca la llames por iniciativa propia. El descarte dura 24h (no para siempre):
 * si el problema real sigue ahí o reaparece, vuelve a mostrarse al día siguiente.
 */
export const descartarRecomendacionControlDiarioTool: ToolDefinition = {
  name: "descartar_recomendacion_control_diario",
  description:
    "Descarta (silencia por 24h) una recomendación del Diagnóstico Diario del chat, para que no " +
    "vuelva a aparecer como incidencia hoy. Úsala SOLO cuando el usuario, después de que investigaste " +
    "esa recomendación con datos reales y se la explicaste, te pida explícitamente que la obvies/" +
    "descartes/ignores — nunca la llames sin que el usuario lo haya pedido, ni sin haber investigado " +
    "antes. El 'id' es el identificador exacto de la recomendación (ej. 'conciliaciones-holded-" +
    "inciertas'), tal como aparece en el Diagnóstico Diario o en la pregunta que te llegó del front.",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Identificador exacto de la recomendación a descartar (ej. 'conciliaciones-holded-inciertas').",
      },
      motivo: {
        type: "string",
        description: "Resumen breve de por qué se descarta (ej. 'diferencia de 1 centavo por redondeo, inmaterial').",
      },
    },
    required: ["id"],
  },
  handler: async (input) => {
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!id) return "Error: falta el id de la recomendación a descartar.";
    const motivo = typeof input.motivo === "string" ? input.motivo.trim() : undefined;

    await descartarRecomendacionControlDiario(id, motivo);
    return `Listo — la recomendación "${id}" queda descartada por 24h. Si el problema real sigue presente o reaparece, el Diagnóstico Diario volverá a mostrarla.`;
  },
};
