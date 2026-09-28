/**
 * Telegram rechaza con «Bad Request: message is too long» todo mensaje de más de 4096 caracteres. Antes no había
 * ningún control de longitud en el cliente: una respuesta o informe largo (caso real 2026-09-28: el informe de una
 * revisión automática de 49 correos, ~4.540 caracteres) fallaba entero aunque el trabajo que describía ya estuviera
 * hecho. Aquí se parte el texto en trozos que siempre caben, cortando por líneas.
 */

/** Tope de «peso» de un trozo: deja margen bajo 4096 para el título, las etiquetas <b>/<blockquote> y el escapado HTML. */
export const MAX_PESO_TROZO_TELEGRAM = 3400;

/**
 * Longitud aproximada del texto una vez formateado como HTML de Telegram: el escapado infla `&` (+4), `<` y `>` (+3)
 * y cada `**` termina siendo parte de <b>…</b> (+2 por marcador, por exceso).
 */
export function pesoTelegram(texto: string): number {
  let peso = texto.length;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === "&") peso += 4;
    else if (c === "<" || c === ">") peso += 3;
    else if (c === "*" && texto[i + 1] === "*") { peso += 2; i++; }
  }
  return peso;
}

/** Corta una línea demasiado larga sin partir un par sustituto (emoji) ni, si se puede, una palabra. */
function cortarLineaLarga(linea: string, maxPeso: number): string[] {
  const partes: string[] = [];
  let resto = linea;
  while (pesoTelegram(resto) > maxPeso) {
    let fin = Math.min(resto.length, maxPeso);
    while (fin > 1 && pesoTelegram(resto.slice(0, fin)) > maxPeso) fin = Math.floor(fin * 0.9);
    const espacio = resto.lastIndexOf(" ", fin);
    if (espacio > fin * 0.5) fin = espacio;
    const c = resto.charCodeAt(fin - 1);
    if (c >= 0xd800 && c <= 0xdbff) fin -= 1; // no dejar un par sustituto a medias
    if (fin < 1) fin = 1;
    partes.push(resto.slice(0, fin).trimEnd());
    resto = resto.slice(fin).trimStart();
  }
  if (resto) partes.push(resto);
  return partes;
}

/**
 * Parte `texto` en trozos de peso ≤ `maxPeso`, siempre en salto de línea (y solo dentro de una línea si esta sola ya
 * excede el tope). Un texto que cabe se devuelve tal cual, en un único trozo. Nunca devuelve trozos vacíos salvo que
 * el texto entero esté vacío.
 */
export function dividirParaTelegram(texto: string, maxPeso = MAX_PESO_TROZO_TELEGRAM): string[] {
  if (pesoTelegram(texto) <= maxPeso) return [texto];
  const trozos: string[] = [];
  let actual = "";
  let pesoActual = 0;
  const cerrar = () => {
    if (actual.trim()) trozos.push(actual.replace(/\s+$/, ""));
    actual = "";
    pesoActual = 0;
  };
  for (const linea of texto.split("\n")) {
    for (const parte of pesoTelegram(linea) > maxPeso ? cortarLineaLarga(linea, maxPeso) : [linea]) {
      const pesoParte = pesoTelegram(parte) + 1; // +1 por el salto de línea
      if (actual && pesoActual + pesoParte > maxPeso) cerrar();
      actual += (actual ? "\n" : "") + parte;
      pesoActual += pesoParte;
    }
  }
  cerrar();
  return trozos.length ? trozos : [texto];
}

/** «Título (2/3)» solo cuando hay más de un trozo. */
export function tituloDeTrozo(titulo: string, indice: number, total: number): string {
  return total > 1 ? `${titulo} (${indice + 1}/${total})` : titulo;
}
