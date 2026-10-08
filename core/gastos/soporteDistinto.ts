import { createHash } from "node:crypto";

/**
 * ¿Hay que ofrecer adjuntar este archivo a un gasto que YA existe en vez de bloquearlo como «ya procesado»?
 *
 * Caso real (Footprint, Booking «Antaris», 2026-10-07): el gasto existía pero su único comprobante era una captura de mapa; el
 * PDF bueno del mismo correo llegaba, Wobi lo reconocía como «ya procesado» (mismo número de documento y proveedor) y se negaba,
 * sin ofrecer adjuntarlo. Un bloqueo por identidad es correcto cuando el archivo ya está adjunto, pero no cuando el gasto sigue sin
 * un soporte con información.
 *
 * Se ofrece SOLO cuando el gasto no tiene ya ese mismo archivo y, además, o no tiene ningún adjunto, o el archivo nuevo es un PDF y
 * ninguno de los adjuntos lo es (todo lo que tiene son imágenes, p. ej. iconos o capturas). Ante cualquier otra duda, se bloquea
 * como siempre: nunca se ofrece por un simple cambio de bytes entre dos versiones del mismo documento.
 */
export function debeOfrecerSoporteDistinto(params: {
  huellaContenido?: string;
  mimeTypeNuevo?: string;
  adjuntosDelGasto: ReadonlyArray<{ bytes: Buffer }>;
}): boolean {
  const huella = params.huellaContenido?.trim().toLowerCase();
  if (!huella) return false;
  const existentes = params.adjuntosDelGasto;
  if (existentes.some((a) => createHash("sha256").update(a.bytes).digest("hex") === huella)) return false;
  if (existentes.length === 0) return true;
  const esPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  return (params.mimeTypeNuevo ?? "").toLowerCase() === "application/pdf" && !existentes.some((a) => esPdf(a.bytes));
}
