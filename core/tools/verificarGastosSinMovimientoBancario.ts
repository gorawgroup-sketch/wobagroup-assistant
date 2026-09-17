import type { ToolDefinition } from "./types";
import { compararCashflowHoldedTool } from "./compararCashflowHolded";

/**
 * Dirección inversa de verificar_cashflow_actualizado: en vez de "¿qué hay
 * en el banco que falta registrar?", responde "¿qué gasto está registrado
 * en el cashflow de esta semana que el banco todavía NO refleja como una
 * salida de dinero real?" — cruce de info entre bancos/cuentas y cashflow,
 * en el sentido que de verdad importa cuando el dinero sigue en la cuenta.
 */
export const verificarGastosSinMovimientoBancarioTool: ToolDefinition = {
  name: "verificar_gastos_sin_movimiento_bancario",
  seguraParaModoRapido: true,
  lecturaAcotable: true,
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
      semana: {
        type: "string",
        description: "Semana concreta, por ejemplo S37. Tiene prioridad sobre periodo.",
      },
    },
  },
  handler: async (input) => {
    return compararCashflowHoldedTool.handler({ ...input, direccion: "cashflow_a_banco", fuente: "bancos" });
  },
};
