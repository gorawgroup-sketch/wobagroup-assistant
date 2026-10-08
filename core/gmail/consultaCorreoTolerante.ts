/**
 * Respaldo para la búsqueda de un correo por su asunto cuando Gmail no lo encuentra.
 *
 * Caso real (Carlos, 2026-10-07): «Fwd: €204.65 - $4,036.92MXN - Hospedaje - Business Trip Guadalajara» devolvía 0 resultados aunque el
 * asunto era exacto: Gmail no casa los importes con separador de miles («$4,036.92MXN»). «Business Trip Guadalajara» a secas sí los
 * encontraba. Si la búsqueda literal no halla nada, se repite solo con las palabras del asunto (sin importes, símbolos ni «Fwd:») y se
 * acepta el resultado únicamente si su asunto real contiene TODAS esas palabras, para no devolver otro correo parecido.
 */
const PREFIJOS = new Set(["fwd", "fw", "re", "rv", "enc"]);
const OPERADOR_GMAIL = /\b(from|to|cc|bcc|subject|after|before|older|newer|older_than|newer_than|has|in|is|label|filename|larger|smaller):/i;

function sinAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Palabras del asunto: solo letras, de 3 o más caracteres, sin prefijos de reenvío. */
export function palabrasDelAsunto(busqueda: string): string[] {
  const palabras = sinAcentos(busqueda).match(/[a-z]{3,}/g) ?? [];
  return [...new Set(palabras.filter((p) => !PREFIJOS.has(p)))];
}

/** Consultas de respaldo (vacío si la búsqueda es una consulta de Gmail con operadores o tiene muy pocas palabras). */
export function consultasDeRespaldo(busqueda: string): string[] {
  if (OPERADOR_GMAIL.test(busqueda.replace(/\b(fwd|fw|re|rv|enc):/gi, ""))) return [];
  const palabras = palabrasDelAsunto(busqueda);
  return palabras.length >= 3 ? [`subject:(${palabras.join(" ")})`] : [];
}

/** ¿El asunto real contiene todas las palabras de la búsqueda? */
export function asuntoContieneLasPalabras(asunto: string, busqueda: string): boolean {
  const palabras = palabrasDelAsunto(busqueda);
  const enAsunto = new Set(sinAcentos(asunto).match(/[a-z]{3,}/g) ?? []);
  return palabras.length >= 3 && palabras.every((p) => enAsunto.has(p));
}
