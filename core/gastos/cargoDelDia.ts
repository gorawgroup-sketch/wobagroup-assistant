import type { MovimientoBancarioCandidato } from "../holded/write";

/**
 * Proveedores recurrentes (Anthropic cobra ~21,6 € cada dos días): un cargo del importe EXACTO pero de otra fecha no es este
 * recibo; el cargo del mismo día con unos céntimos de diferencia (cambio de divisa) sí. Caso real 14-10-2026: recibo del 13/10 de
 * 21,63 €; había un 21,63 € del 08/10 (exacto, 5 días) y un 21,61 € del 13/10 (aproximado, mismo día): se eligió el del 08/10.
 */
export const DIAS_MAXIMOS_EXACTO_PREFERIDO = 2;
export const DIAS_MAXIMOS_APROXIMADO_DEL_DIA = 1;

export function diasEntre(a: string, b: string): number {
  const ma = Date.parse(`${a.slice(0, 10)}T00:00:00Z`), mb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ma) && Number.isFinite(mb) ? Math.abs(ma - mb) / 86_400_000 : Number.POSITIVE_INFINITY;
}

/** Si TODOS los exactos están lejos de la fecha del comprobante, el aproximado del día (si lo hay) es el cargo. */
export function preferirAproximadoDelDia<E extends { fecha: string }, A extends { fecha: string }>(
  exactos: E[], aproximados: A[], fechaComprobante: string
): A | undefined {
  if (!exactos.length || !aproximados.length) return undefined;
  const todosLejos = exactos.every((e) => diasEntre(e.fecha, fechaComprobante) > DIAS_MAXIMOS_EXACTO_PREFERIDO);
  if (!todosLejos) return undefined;
  return [...aproximados].sort((a, b) => diasEntre(a.fecha, fechaComprobante) - diasEntre(b.fecha, fechaComprobante))
    .find((a) => diasEntre(a.fecha, fechaComprobante) <= DIAS_MAXIMOS_APROXIMADO_DEL_DIA);
}

export type CandidatoCargo = MovimientoBancarioCandidato;
