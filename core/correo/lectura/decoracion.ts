/**
 * ¿Es esta parte del correo una imagen decorativa incrustada en el HTML (logo, icono, pixel, separador)? Pura.
 *
 * Caso real (Carlos, 2026-10-07, «Hotel Wynwood – 133.37 usd – revolut», de Booking.com): 58 imágenes llamadas «noname» de 0,3 a
 * 17 KB, todas con Content-ID (es decir, referenciadas desde el HTML), 12 como `inline` y 46 como `attachment`. El filtro solo
 * conocía las `inline`: las 46 restantes se procesaron una a una como si fueran comprobantes (visión, una propuesta o un aviso
 * por imagen, repetidos en cada pasada) y el chat se llenó del mismo mensaje.
 *
 * Regla: una IMAGEN con Content-ID, de tamaño conocido y pequeño (≤ 30 KB, mismo umbral ya medido para las inline), que además
 * llega con el nombre de relleno «noname» (o sin nombre) es decoración, sea cual sea su disposición. Un PDF o cualquier otro
 * documento nunca lo es; una imagen sin Content-ID no está incrustada en ningún sitio; un tamaño desconocido nunca se da por
 * decorativo (fail-open: mejor un adjunto de más que perder un recibo); y una imagen con nombre real sigue la regla anterior.
 */
export const TAMANIO_MAXIMO_IMAGEN_INCRUSTADA = 30_000;

export interface ParteMime {
  filename?: string | null;
  mimeType?: string | null;
  body?: { size?: number | null } | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
}

const NOMBRES_DE_RELLENO = new Set(["noname", ""]);

export function esImagenIncrustadaDeRelleno(part: ParteMime): boolean {
  if (!(part.mimeType ?? "").toLowerCase().startsWith("image/")) return false;
  if (!part.headers?.some((h) => h.name?.toLowerCase() === "content-id")) return false;
  const tamano = part.body?.size;
  if (tamano === undefined || tamano === null) return false;
  if (!NOMBRES_DE_RELLENO.has((part.filename ?? "").trim().toLowerCase())) return false;
  return tamano <= TAMANIO_MAXIMO_IMAGEN_INCRUSTADA;
}
