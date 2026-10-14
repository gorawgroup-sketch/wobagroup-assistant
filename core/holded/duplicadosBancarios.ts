/**
 * La sincronización bancaria de Holded puede dejar un cargo DUPLICADO: la misma fila (descripción, importe y fecha) una vez ya
 * conciliada y otra «pendiente». Esa copia pendiente no es un cargo libre y nunca debe ofrecerse ni conciliarse. Caso real
 * 14-10-2026 (WOBA Main): Anthropic −21,63 € del 08/10 aparecía dos veces; el gasto del 13/10 se concilió contra la copia
 * fantasma del 08/10 mientras el cargo real del 13/10 (−21,61 €) seguía libre.
 */
export interface MovimientoFirma { description?: string; amount?: string | number; booking_date?: string; status?: string }

const CONCILIADO = new Set(["reconciled", "forced_reconciled"]);

export function firmaMovimiento(m: MovimientoFirma): string {
  return `${(m.description ?? "").trim().toLowerCase()}|${Number(m.amount ?? 0).toFixed(2)}|${String(m.booking_date ?? "").slice(0, 10)}`;
}

/** Firmas de los movimientos ya conciliados de la lista (para detectar sus copias pendientes). */
export function firmasConciliadas(movimientos: MovimientoFirma[]): Set<string> {
  return new Set(movimientos.filter((m) => CONCILIADO.has(String(m.status))).map(firmaMovimiento));
}

/** true si este movimiento pendiente es la copia exacta de otro ya conciliado en la misma lista. */
export function esCopiaPendienteDeConciliado(m: MovimientoFirma, firmas: Set<string>): boolean {
  return !CONCILIADO.has(String(m.status)) && firmas.has(firmaMovimiento(m));
}
