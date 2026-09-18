import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extraerDatosFactura, type DatosFactura } from "./extractInvoiceData";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import { manejarClasificacion } from "./processClassification";
import { sendTelegramMessage } from "../telegram/client";
import { esArchivoEml, parsearEml, type AdjuntoDeEml } from "./parseEml";
import { extraerGastoDeCorreo } from "../gmail/extraerGastoDeCorreo";
import { generarComprobantePDF } from "../gmail/generarComprobantePDF";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
}

// image/heic e image/heif — hallazgo real de auditoría (Footprint, factura Hotel Columbus/Costa
// Rica, 2026-09-16): una foto de recibo tomada con iPhone (formato por defecto) nunca se intentaba
// leer como factura, aunque mimeADocumentBlock (documentBlock.ts) ya la convierte a JPEG antes de
// mandarla a Claude — el caso más común de comprobante de gasto (una foto desde el celular) quedaba
// completamente fuera de la detección automática.
export const MIMES_LEGIBLES_COMO_FACTURA = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

/**
 * Mismo criterio que el sniffing de PDF por firma binaria ya usado en documentBlock.ts
 * (mimeADocumentBlock/pdfGenerico): Gmail y otros proveedores a veces entregan un PDF real como
 * application/octet-stream. Hallazgo real de auditoría (2026-09-18): ese sniffing solo corría DESPUÉS
 * de que extraerDatosFactura ya se llamaba — pero tanto el gate principal de este archivo como el
 * buscador de adjuntos útiles dentro de un .eml exigían el mimeType EXACTO antes de intentar leer
 * nada, así que un PDF con MIME genérico nunca llegaba a esa etapa y se archivaba genérico sin
 * haberse leído jamás. Solo confirma un PDF si además coinciden la extensión y los primeros bytes
 * (firma "%PDF-") — el nombre o el MIME por sí solos nunca autorizan a leer bytes arbitrarios.
 */
async function esPdfConMimeGenerico(rutaLocal: string, nombreArchivo: string): Promise<boolean> {
  if (!/\.pdf$/i.test(nombreArchivo)) return false;
  try {
    const fh = await open(rutaLocal, "r");
    try {
      const buf = Buffer.alloc(5);
      const { bytesRead } = await fh.read(buf, 0, 5, 0);
      return bytesRead === 5 && buf.toString("ascii") === "%PDF-";
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

function esBufferPdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function pareceLegibleComoFactura(rutaLocal: string, mimeType: string | undefined, nombreArchivo: string): Promise<boolean> {
  if (mimeType && MIMES_LEGIBLES_COMO_FACTURA.includes(mimeType)) return true;
  const mimeGenericoOAusente = !mimeType || mimeType === "application/octet-stream";
  return mimeGenericoOAusente && (await esPdfConMimeGenerico(rutaLocal, nombreArchivo));
}

/** Best-effort — un archivo que ya no se necesita (ej. el .eml original tras extraer su contenido real). */
async function borrarSiExiste(rutaLocal: string): Promise<void> {
  await unlink(rutaLocal).catch(() => {});
}

/**
 * Un adjunto REAL dentro de un .eml es procesable si es un PDF/imagen por mimeType, si es a su vez
 * otro .eml anidado (reenvío doble — se recursa por el camino normal), o si es un PDF con mimeType
 * genérico pero firma binaria real. Mismo criterio que pareceLegibleComoFactura, pero sin tocar disco
 * — los bytes del adjunto ya están en memoria (mailparser los entrega como Buffer).
 */
function esAdjuntoDeEmlProcesable(adjunto: AdjuntoDeEml): boolean {
  if (MIMES_LEGIBLES_COMO_FACTURA.includes(adjunto.mimeType)) return true;
  if (esArchivoEml(adjunto.mimeType, adjunto.filename)) return true;
  const mimeGenericoOAusente = !adjunto.mimeType || adjunto.mimeType === "application/octet-stream";
  return mimeGenericoOAusente && /\.pdf$/i.test(adjunto.filename) && esBufferPdf(adjunto.content);
}

/**
 * Hallazgo real de auditoría (2026-09-18): un archivo extraído de dentro de un .eml (o un comprobante
 * generado desde su cuerpo) es CONTENIDO NUEVO — no es el mismo adjunto que sigue existiendo en Gmail
 * bajo ese attachmentIdGmail/partId. Si esos campos se propagan sin cambios y la copia local se pierde
 * (ej. redeploy de Railway) antes de subirla a Holded, la recuperación automática
 * (reDescargarAdjuntoSiFalta) traería de vuelta el .eml CRUDO original desde Gmail, no el archivo
 * real — un comprobante corrupto subido a Holded sin ningún error visible. Sin estos campos, si la
 * copia local se pierde, la recuperación simplemente no encuentra nada que descargar (ya manejado como
 * caso normal en gastoCallbackHandler.ts) en vez de sustituir contenido equivocado. El resto del
 * origen (de/asunto/threadId/mensajeIdGmail) se conserva — sigue siendo válido para responder el hilo.
 */
function quitarIdentidadDeAdjuntoGmail(
  correoOrigen: DocumentoLocalEntrante["correoOrigen"]
): DocumentoLocalEntrante["correoOrigen"] {
  if (!correoOrigen) return undefined;
  return { ...correoOrigen, attachmentIdGmail: undefined, partId: undefined };
}

/** Lee y parsea el .eml; si falla, avisa a Carlos explícitamente (no solo por log) y devuelve undefined. */
async function leerEmlOAvisar(entrada: DocumentoLocalEntrante): Promise<Awaited<ReturnType<typeof parsearEml>> | undefined> {
  try {
    const bytes = await readFile(entrada.rutaLocal);
    return await parsearEml(bytes);
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error(`[procesarDocumentoLocal] Error parseando el .eml "${entrada.nombreArchivoOriginal}" (se archiva como documento genérico):`, error);
    await sendTelegramMessage(
      entrada.chatId,
      `⚠️ No pude abrir "${entrada.nombreArchivoOriginal}" como correo reenviado (.eml) — formato no reconocido o corrupto (${mensaje}). ` +
        `Lo archivé como documento genérico por ahora. Avísame si esto se repite para revisar el formato exacto y agregar soporte.`
    ).catch(() => {});
    return undefined;
  }
}

export interface DocumentoLocalEntrante {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  nombreParaClasificar: string;
  captionEfectivo?: string;
  /**
   * Si el archivo llegó como adjunto de un correo, sus datos — para poder
   * responder ese correo (con hilo real, no uno nuevo) después de archivar.
   * Pedido explícito de Carlos tras un caso real: le pidió al chat que
   * archivara un documento Y respondiera el correo original con un link,
   * y sin esto el asistente no tenía forma de saber a qué correo/hilo
   * contestar.
   */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; deColaCorreo?: boolean; /** Gmail interno (correo.id) + attachmentId del adjunto real — permite volver a descargarlo de Gmail si la copia local en tmp/uploads se pierde (ej. un redeploy de Railway entre que se descarga y que se usa). */ mensajeIdGmail?: string; attachmentIdGmail?: string; /** Identidad ESTABLE del adjunto entre lecturas del correo (a diferencia de attachmentIdGmail) — ver AdjuntoCorreo.partId en gmail/client.ts. Se usa para "¿ya procesé este adjunto?", nunca para descargar. */ partId?: string };
  /**
   * Pedido explícito de Carlos, tras un caso real: un correo con 2 adjuntos
   * distintos (mismo expediente de envío marítimo) mandó 2 propuestas
   * seguidas y pareció que había llegado duplicado — eran 2 documentos
   * reales distintos, pero nada lo aclaraba. Se propaga hasta el mensaje
   * final para que quede explícito ("Adjunto 2 de 2 de este correo").
   */
  notaAdjunto?: string;
}

/**
 * Punto único de decisión "¿esto es un gasto o un documento para archivar?"
 * para un archivo YA descargado localmente — sin importar de dónde vino
 * (Telegram, un adjunto de correo, o cualquier fuente futura). Antes esta
 * misma lógica (leer el contenido con extraerDatosFactura, y si es factura
 * mandar a procesarGastoEntrante, si no a manejarClasificacion) vivía
 * duplicada en receiveFile.ts (Telegram) y revisarCorreoNuevo.ts (correo
 * automático) — factorizado acá para no triplicarla al agregar un tercer
 * punto de entrada (capturar_correo bajo demanda).
 */
export async function procesarDocumentoLocal(
  entrada: DocumentoLocalEntrante
): Promise<"gasto_propuesto" | "gasto_pendiente_datos" | "gasto_duplicado" | "archivo"> {
  if (esArchivoEml(entrada.mimeType, entrada.nombreArchivoOriginal)) {
    return procesarAdjuntoEml(entrada);
  }

  if (await pareceLegibleComoFactura(entrada.rutaLocal, entrada.mimeType, entrada.nombreArchivoOriginal)) {
    // Hallazgo real de auditoría (correo con 8 adjuntos de banca móvil, 6 clasificados mal como
    // "no es un gasto"): antes, CUALQUIER excepción real de extraerDatosFactura (un fallo transitorio
    // de la API de Anthropic, o agotar MAX_ITERATIONS sin decisión — ver el throw explícito agregado
    // en extractInvoiceData.ts) se tragaba en silencio y el documento caía al mismo camino
    // ("documento genérico") que una decisión DELIBERADA del modelo de que no es un gasto —
    // indistinguible para Carlos, sin ningún aviso de que en realidad hubo un error, no una lectura
    // real. Un reintento cubre el caso transitorio más común; si sigue fallando, se avisa
    // explícitamente ANTES de archivar como genérico, para que quede claro que es incertidumbre, no
    // una clasificación real.
    let datosFactura: Awaited<ReturnType<typeof extraerDatosFactura>> | undefined;
    let errorLectura: unknown;
    for (let intento = 1; intento <= 2 && !datosFactura; intento++) {
      try {
        datosFactura = await extraerDatosFactura(entrada.rutaLocal, entrada.mimeType, entrada.captionEfectivo, entrada.nombreArchivoOriginal);
      } catch (error) {
        errorLectura = error;
        console.error(`[procesarDocumentoLocal] Error leyendo el documento como factura (intento ${intento}/2):`, error);
      }
    }

    if (datosFactura?.esFacturaOGasto) {
      const resultado = await procesarGastoEntrante({
        chatId: entrada.chatId,
        rutaLocal: entrada.rutaLocal,
        nombreArchivoOriginal: entrada.nombreArchivoOriginal,
        mimeType: entrada.mimeType,
        datos: datosFactura,
        deColaCorreo: entrada.correoOrigen?.deColaCorreo,
        origenAdjuntoGmail:
          entrada.correoOrigen?.mensajeIdGmail && entrada.correoOrigen?.attachmentIdGmail
            ? {
                mensajeIdGmail: entrada.correoOrigen.mensajeIdGmail,
                attachmentIdGmail: entrada.correoOrigen.attachmentIdGmail,
                partId: entrada.correoOrigen.partId,
              }
            : undefined,
        correoOrigen: entrada.correoOrigen
          ? {
              de: entrada.correoOrigen.de,
              asunto: entrada.correoOrigen.asunto,
              threadId: entrada.correoOrigen.threadId,
              messageIdHeader: entrada.correoOrigen.messageIdHeader,
              mensajeIdGmail: entrada.correoOrigen.mensajeIdGmail,
            }
          : undefined,
      });
      if (resultado === "propuesta_enviada") return "gasto_propuesto";
      if (resultado === "propuesta_duplicada") return "gasto_duplicado";
      return "gasto_pendiente_datos";
    }

    if (!datosFactura && errorLectura) {
      const mensaje = errorLectura instanceof Error ? errorLectura.message : String(errorLectura);
      await sendTelegramMessage(
        entrada.chatId,
        `⚠️ No pude leer "${entrada.nombreArchivoOriginal}" para saber si es un gasto (error real leyendo el documento, tras 2 intentos: ${mensaje}) — lo archivo como documento genérico por ahora, pero esto es incertidumbre, no una clasificación real. Revísalo a mano; si es un gasto, reenvíalo.`
      ).catch(() => {});
    }
  }

  await manejarClasificacion({
    chatId: entrada.chatId,
    rutaLocal: entrada.rutaLocal,
    nombreArchivoOriginal: entrada.nombreArchivoOriginal,
    mimeType: entrada.mimeType,
    nombreParaClasificar: entrada.nombreParaClasificar,
    captionEfectivo: entrada.captionEfectivo,
    correoOrigen: entrada.correoOrigen,
    notaAdjunto: entrada.notaAdjunto,
  });
  return "archivo";
}

/**
 * Un .eml es el "sobre" de un correo entero reenviado como archivo — nunca el comprobante en sí.
 * Se abre con parsearEml y, en orden: (1) si trae un adjunto real legible (PDF/imagen), ESE es el
 * comprobante — se procesa recursivamente por el camino normal, con el contexto del .eml (de/asunto)
 * como caption; (2) si no, el propio cuerpo del .eml puede describir un gasto real (ej. una
 * confirmación de reserva de hotel en texto/HTML, sin PDF adjunto) — mismo criterio que
 * revisarCorreoNuevo.ts usa para un correo sin adjunto: se intenta leer como gasto
 * (extraerGastoDeCorreo) y, si lo es, se genera un comprobante visual (generarComprobantePDF, mismo
 * motor ya usado para ese caso) antes de procesarlo; (3) si tampoco, se archiva el .eml original con
 * el contexto ya extraído como caption enriquecido, en vez de un genérico "no sé qué es esto".
 */
async function procesarAdjuntoEml(
  entrada: DocumentoLocalEntrante
): Promise<"gasto_propuesto" | "gasto_pendiente_datos" | "gasto_duplicado" | "archivo"> {
  const contenido = await leerEmlOAvisar(entrada);
  if (!contenido) {
    await manejarClasificacion({
      chatId: entrada.chatId,
      rutaLocal: entrada.rutaLocal,
      nombreArchivoOriginal: entrada.nombreArchivoOriginal,
      mimeType: entrada.mimeType,
      nombreParaClasificar: entrada.nombreParaClasificar,
      captionEfectivo: entrada.captionEfectivo,
      correoOrigen: entrada.correoOrigen,
      notaAdjunto: entrada.notaAdjunto,
    });
    return "archivo";
  }

  const contextoEml =
    `Correo original reenviado como archivo .eml. De: ${contenido.de}. Asunto: ${contenido.asunto}.` +
    (entrada.captionEfectivo ? ` ${entrada.captionEfectivo}` : "");

  // Hallazgo real de auditoría (2026-09-18), 2 casos: (a) un .eml reenviado DOS veces (.eml dentro de
  // otro .eml) antes nunca se detectaba como adjunto útil — se recurre por el camino normal, que
  // vuelve a caer en esta misma función; (b) igual que el gate principal de este archivo, un PDF real
  // con mimeType genérico (application/octet-stream) dentro del .eml antes nunca se leía.
  const adjuntoUtil = contenido.adjuntos.find(esAdjuntoDeEmlProcesable);
  if (adjuntoUtil) {
    await mkdir(UPLOADS_DIR, { recursive: true });
    const rutaInterna = join(UPLOADS_DIR, `${Date.now()}_${sanitizarNombre(adjuntoUtil.filename)}`);
    await writeFile(rutaInterna, adjuntoUtil.content);
    const resultado = await procesarDocumentoLocal({
      ...entrada,
      rutaLocal: rutaInterna,
      nombreArchivoOriginal: adjuntoUtil.filename,
      mimeType: adjuntoUtil.mimeType,
      nombreParaClasificar: adjuntoUtil.filename,
      captionEfectivo: contextoEml,
      correoOrigen: quitarIdentidadDeAdjuntoGmail(entrada.correoOrigen),
    });
    await borrarSiExiste(entrada.rutaLocal);
    return resultado;
  }

  // Hallazgo real de auditoría (Footprint, hotel Scandic Holmenkollen Park/Oslo, 2026-09-18): el .eml
  // adjunto es la confirmación del HOTEL (en su moneda local, NOK) — pero el correo EXTERIOR que lo
  // reenvía suele traer el equivalente real en EUR/la moneda de la cuenta (ej. asunto "143,44€ HOTEL...",
  // ya construido por quien reenvía, mismo patrón que "un asunto de reenvío que solo menciona el
  // equivalente" que el propio prompt de extraerGastoDeCorreo ya sabe reconocer — ver su comentario
  // sobre monto_equivalente/moneda_equivalente). Sin este contexto exterior, el lector solo ve la
  // moneda local del comercio y procesarGastoEntrante no puede resolver el gasto contra ninguna cuenta
  // real, dejando un mensaje sin botones pidiendo el monto/moneda exactos — exactamente lo que ya
  // sabíamos que había salido del banco, solo que nunca llegó al lector.
  const cuerpoParaLeer = [entrada.captionEfectivo, contenido.textoPlano || contenido.html || ""]
    .filter(Boolean)
    .join("\n\n---\n\n");

  let datosGasto: DatosFactura | undefined;
  try {
    datosGasto = await extraerGastoDeCorreo(cuerpoParaLeer, {
      de: contenido.de,
      asunto: contenido.asunto,
      fecha: contenido.fecha ?? "",
    });
  } catch (error) {
    console.error(`[procesarDocumentoLocal] Error leyendo el .eml "${entrada.nombreArchivoOriginal}" como gasto (se archiva como documento genérico):`, error);
  }

  if (datosGasto?.esFacturaOGasto) {
    try {
      const bytesComprobante = await generarComprobantePDF(
        { de: contenido.de, asunto: contenido.asunto, fecha: contenido.fecha ?? "", cuerpoCompleto: contenido.textoPlano, htmlOriginal: contenido.html },
        datosGasto
      );
      await mkdir(UPLOADS_DIR, { recursive: true });
      const nombreComprobante = `comprobante_${sanitizarNombre(entrada.nombreArchivoOriginal.replace(/\.eml$/i, ".pdf"))}`;
      const rutaComprobante = join(UPLOADS_DIR, `${Date.now()}_${nombreComprobante}`);
      await writeFile(rutaComprobante, bytesComprobante);

      const resultado = await procesarGastoEntrante({
        chatId: entrada.chatId,
        rutaLocal: rutaComprobante,
        nombreArchivoOriginal: nombreComprobante,
        mimeType: "application/pdf",
        datos: datosGasto,
        deColaCorreo: entrada.correoOrigen?.deColaCorreo,
        // Este comprobante es GENERADO (nunca descargado de Gmail) — nunca hay un attachmentIdGmail/
        // partId real que lo identifique, ver quitarIdentidadDeAdjuntoGmail más arriba.
        origenAdjuntoGmail: undefined,
        correoOrigen: entrada.correoOrigen
          ? {
              de: entrada.correoOrigen.de,
              asunto: entrada.correoOrigen.asunto,
              threadId: entrada.correoOrigen.threadId,
              messageIdHeader: entrada.correoOrigen.messageIdHeader,
              mensajeIdGmail: entrada.correoOrigen.mensajeIdGmail,
            }
          : undefined,
      });
      await borrarSiExiste(entrada.rutaLocal);
      if (resultado === "propuesta_enviada") return "gasto_propuesto";
      if (resultado === "propuesta_duplicada") return "gasto_duplicado";
      return "gasto_pendiente_datos";
    } catch (error) {
      console.error(`[procesarDocumentoLocal] Error generando el comprobante visual del .eml "${entrada.nombreArchivoOriginal}" (se archiva como documento genérico):`, error);
    }
  }

  await manejarClasificacion({
    chatId: entrada.chatId,
    rutaLocal: entrada.rutaLocal,
    nombreArchivoOriginal: entrada.nombreArchivoOriginal,
    mimeType: entrada.mimeType,
    nombreParaClasificar: entrada.nombreParaClasificar,
    captionEfectivo: contextoEml,
    correoOrigen: entrada.correoOrigen,
    notaAdjunto: entrada.notaAdjunto,
  });
  return "archivo";
}

export interface ResultadoGastoForzado {
  resultado?: "gasto_propuesto" | "gasto_pendiente_datos" | "gasto_duplicado";
  error?: string;
}

/**
 * Camino FORZADO para el botón "💰 Es un gasto" (doc_esgasto/desamb_esgasto) cuando el archivo es un
 * .eml. Hallazgo real de auditoría (2026-09-18): ese botón, pensado como red de seguridad SIEMPRE
 * disponible (pedido explícito de Carlos: "así creas que sea para procesar de manera diferente...
 * incluyele un botón que dice procesar como gasto"), rechazaba cualquier .eml porque solo sabía leer
 * PDF/imagen directamente — exactamente el caso real (hotel Scandic Holmenkollen Park) que motivó
 * agregar soporte de lectura de .eml el mismo día, sin conectar ambas funciones entre sí. A diferencia
 * de procesarAdjuntoEml (camino automático, que archiva si no reconoce un gasto), acá el usuario YA
 * confirmó que es un gasto — nunca cae a archivar; fuerza esFacturaOGasto=true igual que doc_esgasto
 * ya hace para un PDF/imagen directo. Solo devuelve `error` cuando de verdad no hay ningún dato que
 * procesar (.eml malformado, o fallo real leyendo/generando el comprobante).
 */
export async function procesarEmlComoGastoForzado(entrada: DocumentoLocalEntrante): Promise<ResultadoGastoForzado> {
  let contenido: Awaited<ReturnType<typeof parsearEml>>;
  try {
    const bytes = await readFile(entrada.rutaLocal);
    contenido = await parsearEml(bytes);
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    return { error: `no pude abrir "${entrada.nombreArchivoOriginal}" como correo reenviado (.eml): ${mensaje}` };
  }

  const contextoEml =
    `Correo original reenviado como archivo .eml. De: ${contenido.de}. Asunto: ${contenido.asunto}.` +
    (entrada.captionEfectivo ? ` ${entrada.captionEfectivo}` : "");

  const adjuntoUtil = contenido.adjuntos.find(esAdjuntoDeEmlProcesable);
  if (adjuntoUtil) {
    await mkdir(UPLOADS_DIR, { recursive: true });
    const rutaInterna = join(UPLOADS_DIR, `${Date.now()}_${sanitizarNombre(adjuntoUtil.filename)}`);
    await writeFile(rutaInterna, adjuntoUtil.content);

    if (esArchivoEml(adjuntoUtil.mimeType, adjuntoUtil.filename)) {
      const resultado = await procesarEmlComoGastoForzado({
        ...entrada,
        rutaLocal: rutaInterna,
        nombreArchivoOriginal: adjuntoUtil.filename,
        mimeType: adjuntoUtil.mimeType,
        nombreParaClasificar: adjuntoUtil.filename,
        captionEfectivo: contextoEml,
        correoOrigen: quitarIdentidadDeAdjuntoGmail(entrada.correoOrigen),
      });
      await borrarSiExiste(entrada.rutaLocal);
      return resultado;
    }

    let datosFactura: DatosFactura;
    try {
      datosFactura = await extraerDatosFactura(rutaInterna, adjuntoUtil.mimeType, contextoEml, adjuntoUtil.filename);
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      return { error: `no pude leer el adjunto real dentro del .eml ("${adjuntoUtil.filename}"): ${mensaje}` };
    }
    const resultadoGasto = await procesarGastoEntrante({
      chatId: entrada.chatId,
      rutaLocal: rutaInterna,
      nombreArchivoOriginal: adjuntoUtil.filename,
      mimeType: adjuntoUtil.mimeType,
      datos: { ...datosFactura, esFacturaOGasto: true },
      deColaCorreo: entrada.correoOrigen?.deColaCorreo,
      origenAdjuntoGmail: undefined,
      correoOrigen: entrada.correoOrigen
        ? {
            de: entrada.correoOrigen.de,
            asunto: entrada.correoOrigen.asunto,
            threadId: entrada.correoOrigen.threadId,
            messageIdHeader: entrada.correoOrigen.messageIdHeader,
            mensajeIdGmail: entrada.correoOrigen.mensajeIdGmail,
          }
        : undefined,
    });
    await borrarSiExiste(entrada.rutaLocal);
    return { resultado: mapearResultadoGasto(resultadoGasto) };
  }

  const cuerpoParaLeer = [entrada.captionEfectivo, contenido.textoPlano || contenido.html || ""].filter(Boolean).join("\n\n---\n\n");

  let datosGasto: DatosFactura | undefined;
  try {
    datosGasto = await extraerGastoDeCorreo(cuerpoParaLeer, { de: contenido.de, asunto: contenido.asunto, fecha: contenido.fecha ?? "" });
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    return { error: `no pude leer el cuerpo del .eml como gasto: ${mensaje}` };
  }

  try {
    const bytesComprobante = await generarComprobantePDF(
      { de: contenido.de, asunto: contenido.asunto, fecha: contenido.fecha ?? "", cuerpoCompleto: contenido.textoPlano, htmlOriginal: contenido.html },
      datosGasto
    );
    await mkdir(UPLOADS_DIR, { recursive: true });
    const nombreComprobante = `comprobante_${sanitizarNombre(entrada.nombreArchivoOriginal.replace(/\.eml$/i, ".pdf"))}`;
    const rutaComprobante = join(UPLOADS_DIR, `${Date.now()}_${nombreComprobante}`);
    await writeFile(rutaComprobante, bytesComprobante);

    const resultadoGasto = await procesarGastoEntrante({
      chatId: entrada.chatId,
      rutaLocal: rutaComprobante,
      nombreArchivoOriginal: nombreComprobante,
      mimeType: "application/pdf",
      // El usuario ya confirmó con el botón que SÍ es un gasto — se fuerza el campo aunque la lectura
      // del cuerpo haya dudado del tipo, igual que doc_esgasto hace para un PDF/imagen directo.
      datos: { ...datosGasto, esFacturaOGasto: true },
      deColaCorreo: entrada.correoOrigen?.deColaCorreo,
      origenAdjuntoGmail: undefined,
      correoOrigen: entrada.correoOrigen
        ? {
            de: entrada.correoOrigen.de,
            asunto: entrada.correoOrigen.asunto,
            threadId: entrada.correoOrigen.threadId,
            messageIdHeader: entrada.correoOrigen.messageIdHeader,
            mensajeIdGmail: entrada.correoOrigen.mensajeIdGmail,
          }
        : undefined,
    });
    await borrarSiExiste(entrada.rutaLocal);
    return { resultado: mapearResultadoGasto(resultadoGasto) };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    return { error: `no pude generar el comprobante desde el cuerpo del .eml: ${mensaje}` };
  }
}

function mapearResultadoGasto(
  resultado: Awaited<ReturnType<typeof procesarGastoEntrante>>
): "gasto_propuesto" | "gasto_pendiente_datos" | "gasto_duplicado" {
  if (resultado === "propuesta_enviada") return "gasto_propuesto";
  if (resultado === "propuesta_duplicada") return "gasto_duplicado";
  return "gasto_pendiente_datos";
}
