/**
 * Protección de coste ANTES de leer o descargar los adjuntos de un correo. Pura.
 *
 * Caso real (Carlos, 2026-10-07): un correo de Booking con 58 imágenes «noname» (logos, iconos, píxeles) se procesó imagen a imagen —
 * descarga, lectura con visión, una propuesta o un aviso por cada una— y costó unos 3-4 USD sin que ninguna fuera un gasto. La regla de
 * Carlos: el sistema debe ser económico y sustentable, y la protección va ANTES de gastar, no cuando el gasto ya está creado.
 *
 * Capas, todas por metadatos (sin bajar ni leer nada):
 *  1. Decoración incrustada (decoracion.ts + esParteDecorativaInline): se descarta en el origen.
 *  2. Repetidas: dos partes con el mismo tipo, nombre y tamaño son el mismo archivo; se lee una.
 *  3. Tope: como mucho MAX_ADJUNTOS_A_LEER por correo; el resto se avisa, no se lee.
 */
export const MAX_ADJUNTOS_A_LEER = 12;

export interface ParteBasica { filename?: string | null; mimeType?: string | null; size?: number | null }

export interface OmitidosPorProteccion { decorativas: number; repetidas: number; exceso: number }

export function huellaDeParte(p: ParteBasica): string {
  return `${(p.mimeType ?? "").toLowerCase()}|${(p.filename ?? "").trim().toLowerCase()}|${p.size ?? ""}`;
}

/** Quita las repetidas (solo si el tamaño es conocido y mayor que 0) y acota al máximo. Conserva el orden. */
export function deduplicarYAcotar<T extends ParteBasica>(partes: readonly T[], max = MAX_ADJUNTOS_A_LEER): { aLeer: T[]; repetidas: number; exceso: number } {
  const vistas = new Set<string>();
  const unicas: T[] = [];
  let repetidas = 0;
  for (const p of partes) {
    const tamanoConocido = typeof p.size === "number" && p.size > 0;
    const huella = huellaDeParte(p);
    if (tamanoConocido && vistas.has(huella)) { repetidas++; continue; }
    if (tamanoConocido) vistas.add(huella);
    unicas.push(p);
  }
  return { aLeer: unicas.slice(0, max), repetidas, exceso: Math.max(0, unicas.length - max) };
}

export function mensajeDeExceso(exceso: number, max = MAX_ADJUNTOS_A_LEER): string {
  return `⚠️ Este correo trae ${exceso} adjunto(s) más de los que leo por correo (máximo ${max}, por protección de coste de IA). ` +
    `Revisé los primeros; si falta alguno, pídeme «revisa el correo …, solo el adjunto …».`;
}
