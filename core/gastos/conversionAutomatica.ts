/**
 * Resolver solo una factura en una moneda que la empresa no tiene como cuenta (MXN, NOK, CRC…). Puras.
 *
 * Regla de Carlos (2026-10-08): el gasto se registra en EUR o USD, convertido a la tasa del día, y se busca en el banco la transacción
 * que da esa conversión; Wobi no debe preguntar nada que pueda resolver él mismo (la tasa la busca él, en internet si hace falta).
 *
 * Orden: 1) el único cargo que coincide con la conversión; 2) si hay varios, el más cercano en fecha e importe a la conversión;
 * 3) si no hay ninguno, la conversión a la tasa del día en la moneda de la empresa, y la conciliación posterior ajusta el cambio.
 */
export interface CargoCandidato { monto: number; montoReferencia?: number; fecha: string; moneda?: string }

const TOLERANCIA_DESVIO = 0.08;
const MARGEN_DESEMPATE = 0.005;

const dias = (fecha: string): number => {
  const t = Date.parse(`${fecha.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : Number.NaN;
};

function medida<T extends CargoCandidato>(c: T, fechaDocumento: string): { dias: number; desvio: number } | undefined {
  if (c.montoReferencia === undefined || !(c.montoReferencia > 0)) return undefined;
  const desvio = Math.abs(Math.abs(c.monto) - c.montoReferencia) / c.montoReferencia;
  const d = Math.abs(dias(c.fecha) - dias(fechaDocumento));
  if (!Number.isFinite(d) || d > 1 || desvio > TOLERANCIA_DESVIO) return undefined;
  return { dias: d, desvio };
}

/** El cargo más cercano en fecha (±1 día) e importe (≤ 8 %) a la conversión; undefined si ninguno o si dos quedan igual de cerca. */
export function mejorCargoPorCercania<T extends CargoCandidato>(candidatos: readonly T[], fechaDocumento: string): T | undefined {
  const medidos = candidatos
    .map((c) => ({ c, m: medida(c, fechaDocumento) }))
    .filter((x): x is { c: T; m: { dias: number; desvio: number } } => x.m !== undefined)
    .sort((a, b) => a.m.dias - b.m.dias || a.m.desvio - b.m.desvio);
  if (medidos.length === 0) return undefined;
  if (medidos.length === 1) return medidos[0].c;
  const [mejor, segundo] = medidos;
  const claramenteMejor = mejor.m.dias < segundo.m.dias || segundo.m.desvio - mejor.m.desvio >= MARGEN_DESEMPATE;
  return claramenteMejor ? mejor.c : undefined;
}

/** Moneda en la que se registra un gasto convertido: EUR si la empresa la tiene, si no USD, si no la primera que tenga. */
export function monedaDestinoPreferida(monedasReales: Iterable<string>): string | undefined {
  const monedas = [...monedasReales].map((m) => m.toUpperCase().trim()).filter(Boolean);
  return ["EUR", "USD"].find((m) => monedas.includes(m)) ?? monedas.sort()[0];
}

export function convertirATasa(monto: number, tasa: number | undefined): number | undefined {
  if (tasa === undefined || !Number.isFinite(tasa) || tasa <= 0 || !Number.isFinite(monto) || monto <= 0) return undefined;
  return Math.round(monto * tasa * 100) / 100;
}
