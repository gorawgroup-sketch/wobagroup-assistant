import convertirHeic from "heic-convert";

// El SDK instalado no declara tipos para bloques "document" (PDF) — la API
// sí los soporta (no son beta), así que se define el shape local y se
// castea al armar el mensaje, en vez de forzar un upgrade de SDK que toque
// el resto del proyecto por una sola función. Compartido entre
// extractInvoiceData.ts (lectura de facturas) y transcribeForCapture.ts
// (transcripción de documentos para la base de conocimiento) — misma
// conversión MIME real, dos usos distintos de Claude vision.
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

const MIMES_HEIC = ["image/heic", "image/heif"];

/**
 * Hallazgo real de auditoría (Footprint, factura Hotel Columbus/Costa Rica, 2026-09-16): una foto de
 * recibo tomada con iPhone (formato HEIC/HEIF, el que usa por defecto) NUNCA se intentaba leer como
 * factura ni como captura de conocimiento — Claude no acepta HEIC/HEIF crudo en sus bloques de
 * imagen, así que este tipo se excluía de la lectura por completo y caía siempre al flujo de archivo
 * genérico, sin importar el contenido real. Como una foto de recibo desde el celular es exactamente
 * el caso más común de comprobante de gasto, esto bloqueaba la detección automática para una fracción
 * significativa de gastos reales. Se convierte a JPEG antes de leerlo — mismo contenido visual, un
 * formato que la API sí acepta.
 */
export async function mimeADocumentBlock(rutaLocal: string, mimeType: string | undefined, data: Buffer): Promise<DocumentOrImageBlock | TextBlock> {
  if (mimeType && MIMES_TEXTO_PLANO.includes(mimeType)) {
    return { type: "text", text: data.toString("utf-8") };
  }

  if (mimeType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } };
  }

  if (mimeType && MIMES_HEIC.includes(mimeType)) {
    let jpegBytes: Uint8Array;
    try {
      jpegBytes = await convertirHeic({ buffer: data, format: "JPEG", quality: 0.92 });
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo convertir la imagen HEIC/HEIF a JPEG para leerla (${rutaLocal}): ${mensaje}`);
    }
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(jpegBytes).toString("base64") } };
  }

  const imageMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (mimeType && imageMimes.includes(mimeType)) {
    return { type: "image", source: { type: "base64", media_type: mimeType, data: data.toString("base64") } };
  }

  throw new Error(`Tipo de archivo no soportado para lectura de documentos: ${mimeType ?? "(desconocido)"} (${rutaLocal})`);
}
