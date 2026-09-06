/**
 * Pedido explícito de Carlos: "no envíes avisos en fin de semana... solo
 * envía avisos en días hábiles españoles". Se usa para los avisos
 * PROACTIVOS/informativos de los crons (correo sin revisar, resumen diario
 * de pendientes, costos de IA, etc.) — deliberadamente NO se aplica a
 * avisos con una fecha límite real (alertas fiscales, aplazamiento de
 * impuestos) ni a acciones que Carlos programó para un momento específico
 * (revisarAccionesProgramadas) — esos deben seguir avisando aunque caiga en
 * fin de semana, para no arriesgar que se pase un vencimiento real o que
 * una acción programada a propósito para un sábado nunca se dispare.
 *
 * No contempla festivos españoles todavía (solo sábado/domingo) — se puede
 * agregar si hace falta, pero por ahora es el pedido literal de Carlos.
 */
const FORMATO_FECHA_MADRID = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const FORMATO_DIA_SEMANA_MADRID = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Madrid",
  weekday: "short",
});

/** "YYYY-MM-DD" de `fecha` en hora de Madrid — para comparar "mismo día" sin depender de la zona horaria del servidor. */
export function fechaHoyEspana(fecha: Date = new Date()): string {
  return FORMATO_FECHA_MADRID.format(fecha);
}

/** true de lunes a viernes en hora de Madrid (sin festivos todavía). */
export function esDiaHabilEspana(fecha: Date = new Date()): boolean {
  const dia = FORMATO_DIA_SEMANA_MADRID.format(fecha);
  return dia !== "Sat" && dia !== "Sun";
}
