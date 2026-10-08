/**
 * Número de reserva / confirmación escrito en el texto de un correo. Pura.
 *
 * Caso real (Footprint, Hospedaje Guadalajara, 2026-10-07): el gasto ya existía en Holded con la reserva 5773032811 como número de documento,
 * pero al leer una captura del mismo correo el extractor no devolvió ningún número, y la búsqueda de duplicados (que se apoya en el número)
 * no lo reconoció y propuso crear otro. El número estaba, letra por letra, en el cuerpo del correo («Número de reserva 5773032811»).
 *
 * Solo se acepta un número junto a una etiqueta de reserva/confirmación y con 6 a 20 cifras. Si el texto menciona DOS o más números de
 * reserva distintos (un hilo con varias reservas), no se elige ninguno: nunca se adivina.
 */
const ETIQUETA = "(?:n[úu]mero\\s+de\\s+(?:reserva|confirmaci[óo]n)|booking\\s+(?:number|reference|no\\.?)|confirmation\\s+(?:number|no\\.?)|confirmation\\s*:|reservation\\s+(?:number|no\\.?)|n[ºo°]\\s*de\\s+reserva|localizador)";
const PATRON = new RegExp(`${ETIQUETA}\\s*[:#.\\-–]?\\s*[*_\`>\\s]*?(\\d{6,20})\\b`, "gi");

export function numeroDeReservaEnTexto(texto: string | undefined): string | undefined {
  if (!texto) return undefined;
  const encontrados = new Set<string>();
  for (const m of texto.matchAll(PATRON)) encontrados.add(m[1]);
  return encontrados.size === 1 ? [...encontrados][0] : undefined;
}
