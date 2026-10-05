/**
 * Importes del vigilante de seguros.
 *
 * La `prima` del registro es texto libre escrito a mano y en la práctica mezcla formatos: «1475.84», «289.14»,
 * pero también «1971.86 (2 cuotas semestrales: 1.016,86 + ~955 aprox)» o «529.16 (cotizado, anual)». Para cruzarla
 * con el banco solo sirve la primera clase: un importe inequívoco. Cualquier otra cosa devuelve `null` y el
 * vigilante NO adivina (un importe mal leído marcaría como pagado lo que no lo está).
 */

const aCentimos = (valor: number): number => Math.round(valor * 100);

/** Dos importes son el mismo pago si coinciden al céntimo. */
export function mismoImporte(a: number, b: number): boolean {
  return aCentimos(a) === aCentimos(b);
}

/**
 * Importe de un texto de prima SOLO si es un número limpio (con símbolo de euro opcional).
 * Acepta «1475.84», «1475,84», «1.475,84», «234» y «234 €». Rechaza «1.475» (¿mil cuatrocientos o uno con
 * cuatrocientos setenta y cinco milésimas?), cualquier texto con letras u otras cifras, y lo vacío.
 */
export function parsearImporteSimple(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const limpio = texto.trim().replace(/\s+/g, "").replace(/(€|eur|euros)$/i, "");
  if (!limpio) return null;
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(limpio)) return Number(limpio.replace(/\./g, "").replace(",", "."));
  if (/^\d+,\d{1,2}$/.test(limpio)) return Number(limpio.replace(",", "."));
  if (/^\d+\.\d{1,2}$/.test(limpio)) return Number(limpio);
  if (/^\d+$/.test(limpio)) return Number(limpio);
  return null;
}

/** Importe en formato español para los avisos: 1.306,00 */
export function formatearEuros(valor: number): string {
  const [entero, decimales] = Math.abs(valor).toFixed(2).split(".");
  return `${valor < 0 ? "-" : ""}${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimales}`;
}
