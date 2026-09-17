import type { ToolDefinition } from "./types";
import { compararCashflowHoldedTool } from "./compararCashflowHolded";

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
 *
 * Bug real encontrado en vivo: al preguntar por una semana pasada CONCRETA
 * (ej. "revisa S36"), esta tool solo sabía calcular "semana actual" o
 * "semana anterior" — nada más atrás. Sin forma de pedirle una semana
 * específica, el asistente terminaba improvisando su propia comparación
 * manual (leyendo consultar_cashflow_detalle y los movimientos de Holded
 * por separado, sin el matching por tolerancia/duplicados/agrupación que
 * esta función ya tiene) — eso produjo falsos "falta registrar" para cosas
 * que sí estaban, y hasta mezcló datos de Footprint (que NO tiene cashflow
 * en esta hoja) con la revisión de WOBA/EWORKS. Ahora acepta `semana`
 * directamente (ej. "S36"), reutilizando lunesDeEtiquetaSemana — así
 * cualquier semana pasada usa la MISMA lógica robusta, nunca una
 * improvisada.
 */
export const verificarCashflowActualizadoTool: ToolDefinition = {
  name: "verificar_cashflow_actualizado",
  seguraParaModoRapido: true,
  lecturaAcotable: true,
  description:
    "Verifica si el cashflow de WOBA y/o EWORKS está REALMENTE al día, comparando los movimientos " +
    "bancarios reales de Holded contra lo ya registrado en la hoja DATOS — no es un resumen de números, " +
    "hace la comparación real (con tolerancia de monto, agrupación de cargos repetidos, y detección de " +
    "posibles duplicados por nombre/monto parecido que pregunta en vez de asumir). Úsala SIEMPRE que " +
    "pregunten '¿está actualizado el cashflow?', '¿está al día?', '¿falta algo por registrar?', 'revisa la " +
    "semana X/S36', pidan 'conciliar/verificar el cashflow' (aunque digan 'conciliar', NO es " +
    "consultar_movimientos_sin_conciliar — esa mira el estado interno de Holded, no la hoja de cashflow), " +
    "o pidan comparar contra Holded — para CUALQUIER semana, pasada o presente, no solo la " +
    "actual/anterior. Nunca compares manualmente leyendo consultar_cashflow_detalle y los movimientos de " +
    "Holded por separado — esta tool ya tiene la lógica de matching correcta (tolerancias, agrupación, " +
    "duplicados aprendidos) y evita falsos 'falta registrar'. Footprint NO tiene cashflow en esta hoja — " +
    "nunca la uses para Footprint, ni mezcles sus números de Holded con este resultado, aunque el concepto " +
    "(ej. 'Seguridad Social') también aplique a Footprint por separado. Para preguntas de 'cómo va el " +
    "balance' sin pedir verificación, usa mejor consultar_cashflow_resumen (más rápido, no cruza contra " +
    "Holded). Nunca escribe ni propone nada — solo reporta qué falta, si falta algo.",
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
          "'semana_actual' (por defecto si no se da 'semana') revisa lo que va de la semana en curso, de " +
          "lunes a hoy. 'semana_anterior' revisa la semana pasada completa (lunes a domingo). Ignorado si " +
          "se da 'semana'.",
      },
      semana: {
        type: "string",
        description:
          "Etiqueta de una semana CONCRETA a revisar, ej. 'S36' — para cuando preguntan por una semana " +
          "pasada específica (no solo actual/anterior). Si se da, tiene prioridad sobre 'periodo'.",
      },
    },
  },
  handler: async (input) => {
    return compararCashflowHoldedTool.handler({ ...input, direccion: "banco_a_cashflow", fuente: "bancos" });
  },
};
