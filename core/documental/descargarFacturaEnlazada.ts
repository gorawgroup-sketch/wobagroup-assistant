/**
 * Descarga un PDF enlazado en el cuerpo de un correo (ver core/gmail/enlacesFacturaEnCorreo.ts).
 * A diferencia de un adjunto real de Gmail (que ya pasó por el antivirus/antispam de Google antes de
 * llegar), esto es contenido de un servidor de terceros elegido por el remitente — se trata como
 * dato no confiable: solo lectura, nunca se ejecuta ni se abre, con límites estrictos de tiempo y
 * tamaño, y se exige la firma real de PDF (además del content-type, que un servidor puede mentir).
 */
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 15 * 1024 * 1024;

export class DescargaFacturaEnlazadaError extends Error {}

export async function descargarFacturaEnlazada(url: string): Promise<Buffer> {
  let respuesta: Response;
  try {
    respuesta = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  } catch (error) {
    throw new DescargaFacturaEnlazadaError(
      `No se pudo descargar el enlace (${error instanceof Error ? error.message : "fallo de red"}).`
    );
  }
  if (!respuesta.ok) throw new DescargaFacturaEnlazadaError(`El enlace respondió ${respuesta.status}.`);
  const longitudDeclarada = Number(respuesta.headers.get("content-length"));
  if (Number.isFinite(longitudDeclarada) && longitudDeclarada > MAX_BYTES) {
    throw new DescargaFacturaEnlazadaError(`El archivo enlazado supera el límite seguro de ${MAX_BYTES} bytes.`);
  }
  const bytes = Buffer.from(await respuesta.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    throw new DescargaFacturaEnlazadaError(`El archivo enlazado supera el límite seguro de ${MAX_BYTES} bytes.`);
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new DescargaFacturaEnlazadaError("El enlace no descargó un PDF real (firma de archivo inválida).");
  }
  return bytes;
}
