// El SDK instalado no declara tipos para bloques "document" (PDF) — la API
// sí los soporta (no son beta), así que se define el shape local y se
// castea al armar el mensaje, en vez de forzar un upgrade de SDK que toque
// el resto del proyecto por una sola función. Compartido entre
// extractInvoiceData.ts (lectura de facturas) y transcribeForCapture.ts
// (transcripción de documentos para la base de conocimiento) — misma
// conversión MIME real, dos usos distintos de Claude vision.
import { convertirHeicAJpeg } from "./convertHeic";
import { MIMES_HEIC, mimeDeLectura } from "./readableFormats";

export interface DocumentOrImageBlock {
  type: "document" | "image";
  source: { type: "base64"; media_type: string; data: string };
}

// Hallazgo real (Carlos, 2026-09-11 — un blueprint técnico real en Markdown, reenviado como parte de
// una reunión, rechazado con "Tipo de archivo no soportado" al intentar "Guardar como conocimiento"):
// texto plano/Markdown es el caso MÁS fácil de leer — ni siquiera necesita visión/OCR, es texto real
// ya — pero antes caía directo al throw genérico de abajo junto con cualquier tipo verdaderamente no
// soportado.
export interface TextBlock {
  type: "text";
  text: string;
}

const MIMES_TEXTO_PLANO = ["text/markdown", "text/x-markdown", "text/plain"];

export function mimeADocumentBlock(rutaLocal: string, mimeType: string | undefined, data: Buffer): DocumentOrImageBlock | TextBlock {
  mimeType = mimeDeLectura(mimeType, rutaLocal);
  if (mimeType && MIMES_TEXTO_PLANO.includes(mimeType)) {
    return { type: "text", text: data.toString("utf-8") };
  }

  const base64 = data.toString("base64");

  if (mimeType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
  }

  const imageMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (mimeType && imageMimes.includes(mimeType)) {
    return { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } };
  }

  throw new Error(`Tipo de archivo no soportado para lectura de documentos: ${mimeType ?? "(desconocido)"} (${rutaLocal})`);
}

/** HEIC can contain several images: send them all rather than silently reading only the first. */
export async function prepararBloquesDocumento(
  rutaLocal: string, mimeType: string | undefined, data: Buffer, nombreArchivo = rutaLocal
): Promise<Array<DocumentOrImageBlock | TextBlock>> {
  const mime = mimeDeLectura(mimeType, nombreArchivo);
  if (!MIMES_HEIC.includes(mime)) return [mimeADocumentBlock(rutaLocal, mime, data)];
  const images = await convertirHeicAJpeg(data);
  return images.map((image) => ({
    type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") },
  }));
}
