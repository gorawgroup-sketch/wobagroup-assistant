import { extname } from "node:path";

export const MIMES_HEIC = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
export const MIMES_LEGIBLES_COMO_FACTURA = [
  "application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif", ...MIMES_HEIC,
];

export function mimeDeLectura(mimeType: string | undefined, nombreArchivo: string): string {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (!mime || mime === "application/octet-stream") {
    const extension = extname(nombreArchivo).toLowerCase();
    if (extension === ".heic") return "image/heic";
    if (extension === ".heif") return "image/heif";
  }
  return mime;
}

export function esDocumentoLegible(mimeType: string | undefined, nombreArchivo: string): boolean {
  return MIMES_LEGIBLES_COMO_FACTURA.includes(mimeDeLectura(mimeType, nombreArchivo));
}
