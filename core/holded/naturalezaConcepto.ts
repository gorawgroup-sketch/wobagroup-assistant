/**
 * Palabras que describen la NATURALEZA de un gasto, para comparar conceptos entre compras.
 *
 * Caso real (Carlos, 2026-09-28, compra M0U135004 de D1 SAS, Footprint): un ticket de supermercado
 * («Compra elementos de aseo y limpieza (…) — D1 S.A.S., Colombia — Footprint Latin America») acabó en
 * la cuenta «Commission». El nivel «concepto» de inferirCuentaGasto aceptaba la coincidencia de UNA
 * sola palabra de 5+ letras, y la que coincidió fue «america» — no del gasto, sino del nombre de la
 * propia empresa que el extractor añade al concepto — con la línea «Sales Commissions for all
 * Client's in Central America». Cuando el ticket identifica a la persona, el nivel «viaje» decide
 * antes y el fallo no se ve; sin persona, decidía el azar de una palabra.
 *
 * Dos reglas, ambas sobre la causa y no sobre el caso:
 *  1. Solo cuenta la descripción del gasto: el primer segmento del concepto (antes de « — »), sin
 *     paréntesis de importes, sin palabras del proveedor, de la persona, de las empresas del grupo
 *     ni relleno documental. Un nombre propio o un país no dicen de qué naturaleza es el gasto.
 *  2. Una línea histórica solo es comparable si comparte DOS palabras de naturaleza (o la única, si
 *     el concepto solo tiene una): una coincidencia aislada es ruido, no evidencia.
 */
const normalizar = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const RELLENO = new Set([
  "para", "desde", "sobre", "hasta", "todavia", "documento", "adjunto", "generado",
  "comprobante", "correo", "cuerpo", "original", "visual",
  "compra", "compras", "factura", "facturas", "recibo", "ticket", "tickets", "pagos", "cargo", "cargos",
  "gasto", "gastos", "importe", "total", "servicio", "servicios", "varios", "otros",
]);
/** Identidad del grupo y geografía de sus filiales: aparecen en miles de conceptos sin describir nada. */
const IDENTIDAD_GRUPO = new Set([
  "woba", "footprint", "eworks", "business", "group", "global", "limited", "latin", "latam",
  "america", "americas", "latinoamerica", "central", "europe", "europa", "ireland", "irlanda",
  "colombia", "mexico", "espana", "spain", "brasil", "brazil",
]);

export function palabrasNaturalezaGasto(
  concepto: string,
  contexto: { proveedor?: string; personaAsociada?: string } = {}
): string[] {
  const descripcion = concepto.split(/\s+[—–]\s+/)[0].replace(/\([^)]*\b[A-Z]{3}\b[^)]*\)/g, " ");
  const excluidas = new Set([
    ...normalizar(contexto.proveedor ?? "").split(" "),
    ...normalizar(contexto.personaAsociada ?? "").split(" "),
  ]);
  return [...new Set(normalizar(descripcion).split(" ").filter((p) =>
    p.length >= 5 && !/^\d+$/.test(p) && !RELLENO.has(p) && !IDENTIDAD_GRUPO.has(p) && !excluidas.has(p)
  ))];
}

/** ¿La línea histórica comparte naturaleza con el gasto? Dos palabras, o la única disponible. */
export function comparteNaturaleza(textoLinea: string, palabras: string[]): boolean {
  if (palabras.length === 0) return false;
  const enLinea = new Set(normalizar(textoLinea).split(" "));
  const coincidencias = palabras.filter((p) => enLinea.has(p)).length;
  return coincidencias >= Math.min(2, palabras.length);
}
