import type { AnalisisAuto } from "./model";

/** Recupera un par explícito del asunto; no calcula tasas ni mezcla varios recibos. */
export function completarEquivalenteExplicito(analisis: AnalisisAuto, asunto: string): AnalisisAuto {
  if (analisis.recibos.length !== 1) return analisis;
  const r = analisis.recibos[0];
  if (r.equivalente) return analisis;
  const patron = /(?<![\d.,])(?:€\s*(\d+(?:[.,]\d{1,2})?)(?![\d.,])|\$?\s*(\d+(?:[.,]\d{1,2})?)\s*(EUR|MXN|USD|COP)\b)/gi;
  const importes = [...asunto.matchAll(patron)].map(m => ({
    monto: Number((m[1] ?? m[2]).replace(",", ".")), moneda: m[1] ? "EUR" : m[3].toUpperCase(),
  }));
  if (importes.length !== 2 || !importes.some(i => i.moneda === r.moneda && Math.round(i.monto * 100) === Math.round(r.monto * 100))) return analisis;
  const otro = importes.filter(i => i.moneda !== r.moneda && i.monto > 0);
  if (otro.length !== 1) return analisis;
  return { ...analisis, recibos: [{ ...r, equivalente: otro[0] }] };
}
