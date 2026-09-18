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

/**
 * Hallazgo real de auditoría (2026-09-18): antes, un adjunto REAL (PDF/imagen) cuyo nombre de archivo
 * terminara en ".eml" por cualquier motivo (coincidencia, o el nombre que trae el adjunto extraído de
 * dentro de un .eml exterior) se volvía a tratar como .eml solo por el nombre, aunque el mimeType ya
 * dijera con certeza que es un PDF/imagen real — mailparser fallaba al intentar parsear esos bytes
 * binarios como un mensaje de correo, y el documento real terminaba archivado sin leerse. El nombre de
 * archivo solo se usa como señal cuando el mimeType no dice nada concreto (falta o es genérico) —
 * mismo criterio que el sniffing de PDF por firma binaria en documentBlock.ts.
 */
export function esArchivoEml(mimeType: string | undefined, nombreArchivo: string): boolean {
  if (mimeType === MIME_EML) return true;
  const mimeEsGenericoOAusente = !mimeType || mimeType === "application/octet-stream";
  return mimeEsGenericoOAusente && nombreArchivo.toLowerCase().endsWith(".eml");
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

// Mismo criterio y mismo umbral que esParteDecorativaInline en gmail/client.ts — hallazgo real de
// auditoría (2026-09-18): el flag `related` de mailparser (inline + referenciado por cid: en el HTML)
// es EXACTAMENTE el mismo fenómeno que "Content-Disposition: inline" en Gmail, e igual de insuficiente
// por sí solo — un recibo real pegado directo en el cuerpo del correo interior del .eml (mismo patrón
// que los casos reales Polipay/GDL, ya documentados) llega marcado `related` igual que un logo
// decorativo pequeño. Sin el umbral de tamaño, este filtro reabriría ese bug ya corregido del lado de
// Gmail, específicamente para el contenido de un .eml.
const TAMANIO_MAXIMO_INLINE_DECORATIVO_EML = 30000;

/**
 * Parsea los bytes crudos de un archivo .eml (formato RFC 822/MIME estándar — el mismo que usa
 * cualquier cliente de correo, no específico de Gmail) y extrae lo necesario para tratarlo como
 * cualquier otro documento/gasto entrante. Nunca lanza por contenido malformado — un .eml roto
 * produce campos vacíos en vez de tumbar el procesamiento del adjunto que lo contiene.
 */
export async function parsearEml(bytes: Buffer): Promise<ContenidoEml> {
  try {
    const parsed = await simpleParser(bytes, { skipHtmlToText: false });

    const de =
      (typeof parsed.from === "object" && parsed.from && "text" in parsed.from ? parsed.from.text : undefined) ??
      "(remitente desconocido)";
    const asunto = parsed.subject?.trim() || "(sin asunto)";
    const fecha = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : undefined;

    const adjuntos: AdjuntoDeEml[] = (parsed.attachments ?? [])
      .filter(
        (adjunto) =>
          !adjunto.related || typeof adjunto.size !== "number" || adjunto.size > TAMANIO_MAXIMO_INLINE_DECORATIVO_EML
      )
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
  } catch (error) {
    console.error("[parseEml] Contenido .eml malformado, se devuelven campos vacíos:", error instanceof Error ? error.message : error);
    return { asunto: "(sin asunto)", de: "(remitente desconocido)", textoPlano: "", adjuntos: [] };
  }
}
