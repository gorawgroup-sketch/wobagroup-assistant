import { calcularProximasAlertas } from "../fiscal/calendario";
import { formatDateLocal } from "../utils/dateFormat";
import type { ToolDefinition } from "./types";

/**
 * Consulta bajo demanda los vencimientos fiscales/recurrentes próximos, sin
 * esperar al aviso automático diario.
 */
export const alertasFiscalesTool: ToolDefinition = {
  name: "consultar_proximas_alertas",
  seguraParaModoRapido: true,
  description:
    "Consulta qué vencimientos fiscales o pagos recurrentes del grupo (seguridad social, créditos, " +
    "seguros, impuestos, controles médicos...) están próximos a vencer. Úsala cuando el usuario " +
    "pregunte qué vence pronto, qué hay que pagar, o sobre seguros/impuestos/domiciliaciones próximas.",
  input_schema: {
    type: "object",
    properties: {
      dias: {
        type: "number",
        description:
          "Ventana de días hacia adelante a considerar, aplicada por igual a todas las entradas. " +
          "Opcional: si se omite, usa 3 días para vencimientos mensuales (día exacto conocido) y 7 " +
          "días para anuales (fecha aproximada).",
      },
    },
  },
  handler: async (input) => {
    const diasOverride = typeof input.dias === "number" && input.dias > 0 ? input.dias : undefined;
    const alertas = calcularProximasAlertas(new Date(), diasOverride);

    if (alertas.length === 0) {
      return diasOverride
        ? `No hay vencimientos fiscales ni pagos recurrentes en los próximos ${diasOverride} días.`
        : "No hay vencimientos fiscales ni pagos recurrentes próximos (3 días para mensuales, 7 para anuales).";
    }

    return alertas
      .map((a) => {
        const cuando = a.diasParaVencer === 0 ? "hoy" : a.diasParaVencer === 1 ? "mañana" : `en ${a.diasParaVencer} días`;
        return `${a.concepto} (${a.empresa}, ${a.tipo}) — vence ${cuando} (${formatDateLocal(a.fecha)})`;
      })
      .join("\n");
  },
};
