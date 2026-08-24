import { calcularProximasAlertas } from "../fiscal/calendario";
import { formatDateLocal } from "../utils/dateFormat";
import type { ToolDefinition } from "./types";

/**
 * Consulta bajo demanda los vencimientos fiscales/recurrentes próximos, sin
 * esperar al aviso automático diario.
 */
export const alertasFiscalesTool: ToolDefinition = {
  name: "consultar_proximas_alertas",
  description:
    "Consulta qué vencimientos fiscales o pagos recurrentes del grupo (seguridad social, créditos, " +
    "seguros, impuestos, controles médicos...) están próximos a vencer. Úsala cuando el usuario " +
    "pregunte qué vence pronto, qué hay que pagar, o sobre seguros/impuestos/domiciliaciones próximas.",
  input_schema: {
    type: "object",
    properties: {
      dias: {
        type: "number",
        description: "Ventana de días hacia adelante a considerar. Opcional, por defecto 3.",
      },
    },
  },
  handler: async (input) => {
    const dias = typeof input.dias === "number" && input.dias > 0 ? input.dias : 3;
    const alertas = calcularProximasAlertas(dias);

    if (alertas.length === 0) {
      return `No hay vencimientos fiscales ni pagos recurrentes en los próximos ${dias} días.`;
    }

    return alertas
      .map((a) => {
        const cuando = a.diasParaVencer === 0 ? "hoy" : a.diasParaVencer === 1 ? "mañana" : `en ${a.diasParaVencer} días`;
        return `${a.concepto} (${a.empresa}) — vence ${cuando} (${formatDateLocal(a.fecha)})`;
      })
      .join("\n");
  },
};
