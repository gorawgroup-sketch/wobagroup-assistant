/**
 * ¿Dos gastos de hospedaje son la MISMA estancia? Pura. Solo sirve para AVISAR en una propuesta; nunca decide ni bloquea.
 *
 * Caso real (Footprint, Hotel101 Madrid, 9→11 septiembre 2026): el recibo de Booking (232,20 €) y la factura del hotel (242,19 € =
 * 232,20 € de habitaciones + 10,00 € de carga eléctrica) llegaron por correos distintos, con número de documento distinto, y se
 * registraron los dos: la misma estancia contada dos veces. La búsqueda de duplicados solo mira número, proveedor, importe y fecha.
 *
 * Se lee el concepto que Wobi escribe para los hospedajes («Hospedaje <hotel> — <ciudad?> — <persona> — 09-11 sep 2026 (2 noches…)»):
 * misma estancia = mismo hotel + misma persona + mismas fechas de entrada y salida + importe parecido (≤ 8 %) en la misma moneda.
 */
const MESES: Record<string, number> = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
const MES_RE = "(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)[a-z]*";
const GENERICAS = new Set(["hospedaje", "hotel", "apartment", "apartamento", "alojamiento", "booking", "com"]);
const TOLERANCIA_IMPORTE = 0.08;

export interface EstanciaGasto { concepto?: string; monto?: number; moneda?: string }

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function tokens(texto: string): Set<string> {
  return new Set((normalizar(texto).match(/[a-z0-9]{3,}/g) ?? []).filter((t) => !GENERICAS.has(t)));
}

/** «09-11 sep», «07–09 sep», «21 al 23 sep», «30 sep - 02 oct» → entrada y salida (día y mes). */
export function fechasDeEstancia(concepto: string): { desde: { dia: number; mes: number }; hasta: { dia: number; mes: number } } | undefined {
  const t = normalizar(concepto);
  const mismoMes = t.match(new RegExp(`(\\d{1,2})\\s*(?:-|–|—|al|a)\\s*(\\d{1,2})\\s+(?:de\\s+)?${MES_RE}`));
  if (mismoMes) {
    const mes = MESES[mismoMes[3]];
    return { desde: { dia: Number(mismoMes[1]), mes }, hasta: { dia: Number(mismoMes[2]), mes } };
  }
  const variosMeses = t.match(new RegExp(`(\\d{1,2})\\s+(?:de\\s+)?${MES_RE}\\s*(?:-|–|—|al|a)\\s*(\\d{1,2})\\s+(?:de\\s+)?${MES_RE}`));
  if (variosMeses) {
    return { desde: { dia: Number(variosMeses[1]), mes: MESES[variosMeses[2]] }, hasta: { dia: Number(variosMeses[3]), mes: MESES[variosMeses[4]] } };
  }
  return undefined;
}

function segmentos(concepto: string): string[] {
  return concepto.split(/\s+[—–]\s+/).map((s) => s.trim()).filter(Boolean);
}

export function esHospedaje(concepto: string): boolean {
  return /^\s*(hospedaje|alojamiento)\b/i.test(concepto);
}

/** Hotel: lo que sigue a «Hospedaje» en el primer segmento. */
function hotelDe(concepto: string): Set<string> {
  return tokens((segmentos(concepto)[0] ?? "").replace(/^\s*(hospedaje|alojamiento)\s*/i, ""));
}

/** Persona (y ciudad, si la hay): segmentos sin cifras ni paréntesis, es decir, ni el hotel ni las fechas ni las notas. */
function personaDe(concepto: string): Set<string> {
  return tokens(segmentos(concepto).slice(1).filter((s) => !/[\d()+]/.test(s)).join(" "));
}

function contenidoEn(menor: Set<string>, mayor: Set<string>): boolean {
  if (menor.size < 2) return false;
  for (const t of menor) if (!mayor.has(t)) return false;
  return true;
}

function hotelCoincide(a: Set<string>, b: Set<string>): boolean {
  const comunes = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return comunes >= 1 && union > 0 && comunes / union >= 0.5;
}

export function esMismaEstancia(a: EstanciaGasto, b: EstanciaGasto): boolean {
  if (!a.concepto || !b.concepto || !esHospedaje(a.concepto) || !esHospedaje(b.concepto)) return false;
  const fa = fechasDeEstancia(a.concepto), fb = fechasDeEstancia(b.concepto);
  if (!fa || !fb || JSON.stringify(fa) !== JSON.stringify(fb)) return false;
  if (!hotelCoincide(hotelDe(a.concepto), hotelDe(b.concepto))) return false;
  const pa = personaDe(a.concepto), pb = personaDe(b.concepto);
  if (!(pa.size <= pb.size ? contenidoEn(pa, pb) : contenidoEn(pb, pa))) return false;
  if (!a.monto || !b.monto || !a.moneda || !b.moneda || a.moneda.toUpperCase() !== b.moneda.toUpperCase()) return false;
  return Math.abs(a.monto - b.monto) / Math.max(a.monto, b.monto) <= TOLERANCIA_IMPORTE;
}
