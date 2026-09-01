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

export function mimeADocumentBlock(rutaLocal: string, mimeType: string | undefined, data: Buffer): DocumentOrImageBlock {
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
