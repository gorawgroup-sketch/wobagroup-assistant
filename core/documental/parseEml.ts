import { simpleParser } from "mailparser";

/**
 * Pedido explícito de Carlos, tras un caso real (Footprint, hotel Scandic Holmenkollen Park,
 * Noruega, reenviado como .eml dentro de otro correo, 2026-09-18): "asegúrate que lo puedes leer,
 * puedes identificar de qué se trata y lo puedes anexar al gasto" — un correo reenviado por un
 * proveedor externo (ej. Gmail lo ofrece como ".eml" cuando alguien reenvía un mensaje entero en vez
 * de solo su contenido) llegaba como adjunto sin que el sistema supiera leerlo: no es PDF ni imagen
 * (MIMES_LEGIBLES_COMO_FACTURA de procesarDocumentoLocal.ts no lo cubre), así que extraerDatosFactura
 * (lectura por visión) nunca lo intentaba, y caía directo al archivo genérico sin ningún intento de
 * entender su contenido real.
 */
export const MIME_EML = "message/rfc822";

export function esArchivoEml(mimeType: string | undefined, nombreArchivo: string): boolean {
  return mimeType === MIME_EML || nombreArchivo.toLowerCase().endsWith(".eml");
}

export interface AdjuntoDeEml {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface ContenidoEml {
  asunto: string;
  de: string;
  /** ISO 8601, si el .eml trae una fecha real y parseable. */
  fecha?: string;
  textoPlano: string;
  html?: string;
  /**
   * Adjuntos REALES del correo original (ej. la factura/confirmación en PDF que venía dentro del
   * mensaje reenviado) — excluye imágenes inline de firma/logo (mismo criterio que
   * esParteDecorativaInline en gmail/client.ts, aplicado acá vía el flag `related` de mailparser).
   */
  adjuntos: AdjuntoDeEml[];
}

/**
 * Parsea los bytes crudos de un archivo .eml (formato RFC 822/MIME estándar — el mismo que usa
 * cualquier cliente de correo, no específico de Gmail) y extrae lo necesario para tratarlo como
 * cualquier otro documento/gasto entrante. Nunca lanza por contenido malformado — un .eml roto
 * produce campos vacíos en vez de tumbar el procesamiento del adjunto que lo contiene.
 */
export async function parsearEml(bytes: Buffer): Promise<ContenidoEml> {
  const parsed = await simpleParser(bytes, { skipHtmlToText: false });

  const de =
    (typeof parsed.from === "object" && parsed.from && "text" in parsed.from ? parsed.from.text : undefined) ??
    "(remitente desconocido)";
  const asunto = parsed.subject?.trim() || "(sin asunto)";
  const fecha = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : undefined;

  const adjuntos: AdjuntoDeEml[] = (parsed.attachments ?? [])
    .filter((adjunto) => !adjunto.related)
    .map((adjunto) => ({
      filename: adjunto.filename?.trim() || "adjunto",
      mimeType: adjunto.contentType || "application/octet-stream",
      content: adjunto.content,
    }));

  return {
    asunto,
    de,
    fecha,
    textoPlano: typeof parsed.text === "string" ? parsed.text : "",
    html: typeof parsed.html === "string" ? parsed.html : undefined,
    adjuntos,
  };
}
