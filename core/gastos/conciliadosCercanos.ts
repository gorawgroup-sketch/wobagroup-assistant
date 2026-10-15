/**
 * Un cargo YA CONCILIADO solo puede ser «este mismo gasto» si su fecha está cerca de la del comprobante. Los proveedores
 * recurrentes (Anthropic cobra ~21,6 € cada dos días) producen cargos del mismo importe en fechas distintas: un cargo
 * conciliado del 07/10 u 08/10 no es el recibo del 13/10, y tratarlo como «posible duplicado» bloqueaba el gasto y
 * preguntaba al operador algo que el banco ya respondía (había un cargo libre del 13/10). Caso real: Carlos, 14-10-2026.
 */
export const DIAS_MAXIMOS_CONCILIADO_MISMO_GASTO = 2;

export function diasEntreFechasIso(a: string, b: string): number {
  const ma = Date.parse(`${a.slice(0, 10)}T00:00:00Z`), mb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ma) && Number.isFinite(mb) ? Math.abs(ma - mb) / 86_400_000 : Number.POSITIVE_INFINITY;
}

/** Deja solo los cargos conciliados cuya fecha está a ≤ DIAS_MAXIMOS del comprobante (sin fecha válida, no se filtra nada). */
export function conciliadosCercanosAlComprobante<T extends { fecha: string }>(movimientos: T[], fechaComprobante: string): { cercanos: T[]; lejanos: T[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaComprobante)) return { cercanos: movimientos, lejanos: [] };
  const cercanos = movimientos.filter((m) => diasEntreFechasIso(m.fecha, fechaComprobante) <= DIAS_MAXIMOS_CONCILIADO_MISMO_GASTO);
  return { cercanos, lejanos: movimientos.filter((m) => !cercanos.includes(m)) };
}
