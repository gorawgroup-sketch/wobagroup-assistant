/**
 * Formatea una fecha como YYYY-MM-DD usando los componentes LOCALES
 * (getFullYear/getMonth/getDate), no `toISOString()` — que convierte a UTC
 * y puede correr la fecha un día según el timezone del proceso. Úsalo
 * siempre que la fecha represente un día del calendario local (hoy, una
 * fecha de vencimiento, un rango de semana), nunca para timestamps de un
 * instante preciso.
 */
export function formatDateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
