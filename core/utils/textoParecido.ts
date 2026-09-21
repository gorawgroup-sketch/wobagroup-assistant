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
export function palabrasParecidas(a: string, b: string): boolean {
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

/** Minúsculas y sin tildes ("Sanción" → "sancion"), conservando el resto del texto. */
export function minusculasSinTildes(texto: string): string {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase();
}

function limpiarNombre(t: string): string {
  return minusculasSinTildes(t).replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * true si el nombre buscado aparece COMPLETO, como palabra o frase, dentro del candidato ("Luz" en "Luz oficina"),
 * sin distinguir tildes ni mayúsculas. Cubre lo que textosParecidos no puede por diseño — sus palabras de menos
 * de 5 letras se ignoran a propósito para no dar falsos positivos —: nombres cortos idénticos como "Luz", "AWS"
 * o "IVA". Solo en un sentido (el candidato contiene lo buscado) para que un candidato genérico y corto ("Gas")
 * no case con un nombre largo. Pensado para rutas donde otros criterios (semana, importe) ya acotan el candidato.
 */
export function nombresCoinciden(buscado: string, candidato: string): boolean {
  const a = limpiarNombre(buscado);
  const b = limpiarNombre(candidato);
  if (a.length < 2 || b.length < 2) return false;
  return ` ${b} `.includes(` ${a} `);
}

/** true si los dos nombres son el mismo (sin tildes, mayúsculas ni puntuación). */
export function nombresIguales(a: string, b: string): boolean {
  const x = limpiarNombre(a);
  return x.length >= 2 && x === limpiarNombre(b);
}
