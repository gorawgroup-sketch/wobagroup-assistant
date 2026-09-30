import type { AnalisisAuto } from "./model";

/**
 * Asunto con el formato de la política de gastos de Footprint: «<importe cobrado> - <concepto> - <tarjeta>», p. ej.
 * «6,09 euros - Uber Medellin - Visa» o «17,96€ - transporte italiano - Mastercard». Ese importe es lo que salió de la
 * tarjeta, no una estimación.
 *
 * Caso real (Carlos, 2026-09-30): los recibos venían en pesos (Uber 22.943 COP) y el asunto decía lo cobrado
 * («6,09 euros»); el banco tenía el cargo «Uber Pending −6,09 EUR» el mismo día. El analizador lo dejaba como
 * «posible equivalente», no encontraba movimiento y el correo iba a revisión manual.
 *
 * Solo se acepta cuando el asunto EMPIEZA por un único importe con moneda inequívoca (euros o dólares escritos de
 * forma expresa; un «$» solo es ambiguo) seguido de « - ». No calcula tasas: el cargo se verifica después contra el
 * banco, y si no existe un movimiento de ese importe el correo sigue yendo a revisión manual.
 */
export function cargoDelAsuntoPolitica(asunto: string): { monto: number; moneda: "EUR" | "USD" } | undefined {
  const sinPrefijos = asunto.replace(/^\s*(?:(?:fwd?|rv|re|tr)\s*:\s*)+/i, "").trim();
  const numero = String.raw`(\d{1,6}(?:[.,]\d{1,2})?)`;
  const despues = new RegExp(String.raw`^${numero}\s*(€|eur|euros?|usd|us\$|d[oó]lares?)\s+-\s+\S`, "i").exec(sinPrefijos);
  const antes = despues ? undefined : new RegExp(String.raw`^(€|eur|usd|us\$)\s*${numero}\s+-\s+\S`, "i").exec(sinPrefijos);
  const importe = despues?.[1] ?? antes?.[2];
  const marca = (despues?.[2] ?? antes?.[1])?.toLowerCase();
  if (!importe || !marca) return undefined;
  const monto = Number(importe.replace(",", "."));
  if (!Number.isFinite(monto) || monto <= 0) return undefined;
  return { monto, moneda: /^(€|eur)/.test(marca) ? "EUR" : "USD" };
}

/** Recupera un par explícito del asunto; no calcula tasas ni mezcla varios recibos. */
export function completarEquivalenteExplicito(analisis: AnalisisAuto, asunto: string, remitenteDelGrupo = false): AnalisisAuto {
  if (analisis.recibos.length !== 1) return analisis;
  const r = analisis.recibos[0];
  if (r.equivalente) return analisis;
  const conPar = completarParExplicito(analisis, asunto);
  if (conPar !== analisis || !remitenteDelGrupo) return conPar;
  // Política de Footprint: solo para correos de alguien del grupo, que es quien escribe el asunto con lo cobrado.
  const cargo = cargoDelAsuntoPolitica(asunto);
  if (!cargo) return analisis;
  // Mismo importe y moneda que el comprobante: no aporta nada.
  if (cargo.moneda === r.moneda && Math.round(cargo.monto * 100) === Math.round(r.monto * 100)) return analisis;
  return { ...analisis, recibos: [{ ...r, equivalente: cargo }] };
}

function completarParExplicito(analisis: AnalisisAuto, asunto: string): AnalisisAuto {
  const r = analisis.recibos[0];
  // Colombian receipts commonly use a dot to group integer pesos. Only
  // normalize when the full amount agrees with the independently read receipt;
  // do not guess the meaning of separators in the foreign equivalent.
  const asuntoNormalizado = r.moneda === "COP" && Number.isInteger(r.monto)
    ? asunto.replace(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+)\s*COP\b/gi, (original, importe: string) =>
      Number(importe.replace(/\./g, "")) === r.monto ? `${r.monto} COP` : original)
    : asunto;
  const patron = /(?<![\d.,])(?:€\s*(\d+(?:[.,]\d{1,2})?)(?![\d.,])|\$?\s*(\d+(?:[.,]\d{1,2})?)\s*(EUR|MXN|USD|COP)\b)/gi;
  const importes = [...asuntoNormalizado.matchAll(patron)].map(m => ({
    monto: Number((m[1] ?? m[2]).replace(",", ".")), moneda: m[1] ? "EUR" : m[3].toUpperCase(),
  }));
  if (importes.length !== 2 || !importes.some(i => i.moneda === r.moneda && Math.round(i.monto * 100) === Math.round(r.monto * 100))) return analisis;
  const otro = importes.filter(i => i.moneda !== r.moneda && i.monto > 0);
  if (otro.length !== 1) return analisis;
  return { ...analisis, recibos: [{ ...r, equivalente: otro[0] }] };
}
