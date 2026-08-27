/**
 * Devuelve el lunes de la semana ISO a la que pertenece `date` (00:00 local).
 */
export function mondayOf(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay() || 7; // domingo (0) -> 7
  d.setDate(d.getDate() - day + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Número de semana ISO 8601 de `date`.
 */
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Etiqueta de semana tal como se usa en las hojas de cashflow, ej. "S38".
 */
export function weekLabel(date: Date): string {
  return `S${String(isoWeekNumber(date)).padStart(2, "0")}`;
}

/**
 * Rango (lunes-domingo) de la semana anterior a la que contiene `referenceDate`.
 */
export function previousWeekRange(referenceDate: Date): { start: Date; end: Date } {
  const thisMonday = mondayOf(referenceDate);

  const start = new Date(thisMonday);
  start.setDate(start.getDate() - 7);

  const end = new Date(thisMonday);
  end.setDate(end.getDate() - 1);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Rango de la semana EN CURSO (la que contiene `referenceDate`), desde el
 * lunes hasta `referenceDate` inclusive — para el chequeo preliminar del
 * viernes, que revisa lo que va de la semana, no la semana ya cerrada.
 */
export function currentWeekRangeToDate(referenceDate: Date): { start: Date; end: Date } {
  const start = mondayOf(referenceDate);

  const end = new Date(referenceDate);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Reconstruye el lunes de una etiqueta de semana tipo "S35" (formato usado
 * en la hoja CASHFLOW, que no guarda año) — asume que pertenece al año en
 * curso, salvo que el número sea mucho mayor al de la semana actual (ahí
 * probablemente es de fin del año anterior, un "rollover" al cruzar
 * diciembre/enero). Devuelve null si la etiqueta no tiene formato válido.
 */
export function lunesDeEtiquetaSemana(semanaLabel: string, hoy: Date = new Date()): Date | null {
  const match = /^S(\d{1,2})$/i.exec(semanaLabel.trim());
  if (!match) return null;
  const numeroSemana = parseInt(match[1], 10);
  if (numeroSemana < 1 || numeroSemana > 53) return null;

  const numeroSemanaHoy = parseInt(weekLabel(hoy).replace(/^S/i, ""), 10);
  const anio = numeroSemana > numeroSemanaHoy + 10 ? hoy.getFullYear() - 1 : hoy.getFullYear();

  // El 4 de enero siempre cae en la semana ISO 1 del año — desde ahí se
  // calcula el lunes de cualquier otra semana del mismo año.
  const lunesSemana1 = mondayOf(new Date(anio, 0, 4));
  const lunes = new Date(lunesSemana1);
  lunes.setDate(lunes.getDate() + (numeroSemana - 1) * 7);
  return lunes;
}

export { formatDateLocal as formatDateISO } from "./dateFormat";
