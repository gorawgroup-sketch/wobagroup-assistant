/** Fechas de calendario (YYYY-MM-DD) del vigilante. Se opera siempre sobre días, nunca sobre instantes. */

/** Fecha YYYY-MM-DD restando días (en UTC: solo se usa para comparar días de calendario). */
export function restarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** Días enteros entre dos fechas YYYY-MM-DD (hasta − desde). */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((new Date(`${hasta}T00:00:00Z`).getTime() - new Date(`${desde}T00:00:00Z`).getTime()) / 86400000);
}

/** dd/mm de una fecha YYYY-MM-DD, para los avisos. */
export function diaMes(fecha: string): string {
  const [, mes, dia] = fecha.split("-");
  return `${dia}/${mes}`;
}
