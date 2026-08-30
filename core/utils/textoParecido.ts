function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .replace(/[.,/]/g, " ");
}

/**
 * Dos palabras "son la misma" si son iguales o comparten los primeros 6
 * caracteres (nunca menos de 4 de largo) — cubre plural/singular
 * ("créditos"/"crédito") sin exigir coincidencia exacta. El prefijo de 6
 * (no 5) es a propósito: verificado en vivo que con 5 "seguro" y
 * "seguridad" quedaban como "la misma palabra" (comparten "segur"), dando
 * falsos positivos (una búsqueda de "Seguridad social" traía de vuelta
 * pólizas de seguro que no tienen nada que ver) — con 6 ya no colisionan.
 */
function palabrasParecidas(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  const prefijo = Math.min(6, minLen);
  return a.slice(0, prefijo) === b.slice(0, prefijo);
}

export function palabrasDe(texto: string, minLen = 3): string[] {
  return normalizar(texto)
    .split(/\s+/)
    .filter((p) => p.length >= minLen);
}

/**
 * true si ALGUNA palabra "distintiva" (5+ caracteres, para no engancharse
 * con palabras cortas y genéricas) del `objetivo` aparece parecida en
 * `candidato`. Deliberadamente NO exige que la mayoría de las palabras del
 * objetivo coincidan — pensado como fallback cuando una búsqueda por
 * substring exacto falla, y el objetivo suele ser una frase más larga o
 * más genérica que la fila real (ej. "Cuotas de créditos/préstamos" del
 * calendario fiscal vs "Prestamo 36 meses WOBA" real: solo comparten
 * "préstamos"~"Prestamo", y aun así es la fila correcta). Nunca decide un
 * match "seguro" — es un indicio, no una certeza; quien la use debe dejar
 * claro si el match fue exacto o solo parecido (ver cashflowDetalle.ts).
 */
export function textosParecidos(objetivo: string, candidato: string): boolean {
  const palabrasObjetivo = palabrasDe(objetivo, 5);
  if (palabrasObjetivo.length === 0) return false;

  const palabrasCandidato = palabrasDe(candidato, 3);
  return palabrasObjetivo.some((po) => palabrasCandidato.some((pc) => palabrasParecidas(po, pc)));
}
