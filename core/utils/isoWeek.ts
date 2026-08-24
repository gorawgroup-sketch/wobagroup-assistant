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

export { formatDateLocal as formatDateISO } from "./dateFormat";
