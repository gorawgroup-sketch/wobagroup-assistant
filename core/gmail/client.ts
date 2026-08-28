import { google, gmail_v1 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { registrarPersonaDesdeCorreo } from "../directorio/directorioPersonasSheet";

let gmailClient: gmail_v1.Gmail | null = null;

/**
 * Cliente de Gmail de solo lectura, impersonando a GMAIL_IMPERSONATE_EMAIL
 * (el buzón dedicado del asistente, ej. asistente@wobagroup.com) — distinto
 * de GOOGLE_IMPERSONATE_EMAIL (que usa Drive, con la identidad de Carlos
 * porque es quien tiene permiso de Editor en esas carpetas). La misma
 * delegación de dominio autoriza impersonar a cualquier usuario del
 * dominio, por scope — no hace falta configurar nada extra por persona.
 */
function getGmailClient(): gmail_v1.Gmail {
  if (gmailClient) return gmailClient;

  const credentials = loadServiceAccountCredentials();
  const impersonate = process.env.GMAIL_IMPERSONATE_EMAIL;

  if (!impersonate) {
    throw new Error("Falta la variable de entorno GMAIL_IMPERSONATE_EMAIL.");
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    subject: impersonate,
  });

  gmailClient = google.gmail({ version: "v1", auth });
  return gmailClient;
}

let gmailSendClient: gmail_v1.Gmail | null = null;

/**
 * Cliente separado con scope gmail.send, impersonando también a
 * GMAIL_IMPERSONATE_EMAIL. Separado del cliente de lectura por principio de
 * menor privilegio: cada JWT lleva solo el scope que necesita para su uso.
 */
function getGmailSendClient(): gmail_v1.Gmail {
  if (gmailSendClient) return gmailSendClient;

  const credentials = loadServiceAccountCredentials();
  const impersonate = process.env.GMAIL_IMPERSONATE_EMAIL;

  if (!impersonate) {
    throw new Error("Falta la variable de entorno GMAIL_IMPERSONATE_EMAIL.");
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    subject: impersonate,
  });

  gmailSendClient = google.gmail({ version: "v1", auth });
  return gmailSendClient;
}

export interface AdjuntoCorreo {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface CorreoResumen {
  id: string;
  threadId: string;
  messageIdHeader: string;
  de: string;
  asunto: string;
  fecha: string;
  extracto: string;
  adjuntos: AdjuntoCorreo[];
}

function leerHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, nombre: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === nombre.toLowerCase())?.value ?? "";
}

function extraerAdjuntos(payload: gmail_v1.Schema$MessagePart | undefined): AdjuntoCorreo[] {
  const adjuntos: AdjuntoCorreo[] = [];

  function recorrer(part: gmail_v1.Schema$MessagePart | undefined): void {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      adjuntos.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        attachmentId: part.body.attachmentId,
        size: part.body.size ?? 0,
      });
    }
    part.parts?.forEach(recorrer);
  }

  recorrer(payload);
  return adjuntos;
}

/** Lista los IDs de mensajes de la bandeja de entrada recibidos después de `afterUnixSeconds`. */
export async function listarMensajesNuevos(afterUnixSeconds: number): Promise<string[]> {
  const gmail = getGmailClient();
  const q = `after:${afterUnixSeconds} in:inbox`;

  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({ userId: "me", q, pageToken, maxResults: 50 });
    (res.data.messages ?? []).forEach((m) => m.id && ids.push(m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return ids;
}

/**
 * Cuenta los mensajes no leídos de la bandeja de entrada. `resultSizeEstimate`
 * con `maxResults` bajo es una estimación de índice de Gmail muy poco fiable
 * (confirmado en vivo: devolvía 201 cuando el conteo real era 2) — en vez de
 * confiar en la estimación, se paginan los IDs reales y se cuentan.
 */
export async function contarNoLeidos(): Promise<number> {
  const gmail = getGmailClient();
  const LIMITE_PAGINAS = 10; // hasta 5000 mensajes; suficiente para "no leídos" reales
  let total = 0;
  let pageToken: string | undefined;
  let paginas = 0;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread in:inbox",
      maxResults: 500,
      pageToken,
    });
    total += (res.data.messages ?? []).length;
    pageToken = res.data.nextPageToken ?? undefined;
    paginas += 1;
  } while (pageToken && paginas < LIMITE_PAGINAS);

  return total;
}

/** Busca mensajes con una consulta arbitraria de Gmail (ej. `subject:"X" from:y@z.com`). */
export async function buscarMensajes(query: string, maxResults = 10): Promise<string[]> {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
  return (res.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}

/** Trae metadatos + extracto + lista de adjuntos de un mensaje. */
export async function obtenerResumenCorreo(id: string): Promise<CorreoResumen> {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const msg = res.data;

  return {
    id: msg.id ?? id,
    threadId: msg.threadId ?? "",
    messageIdHeader: leerHeader(msg.payload?.headers, "Message-ID"),
    de: leerHeader(msg.payload?.headers, "From"),
    asunto: leerHeader(msg.payload?.headers, "Subject"),
    fecha: leerHeader(msg.payload?.headers, "Date"),
    extracto: msg.snippet ?? "",
    adjuntos: extraerAdjuntos(msg.payload),
  };
}

function decodificarBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/** Busca recursivamente la primera parte text/plain del cuerpo del mensaje. */
function extraerTextoPlano(part: gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodificarBase64Url(part.body.data);
  }
  for (const sub of part.parts ?? []) {
    const encontrado = extraerTextoPlano(sub);
    if (encontrado) return encontrado;
  }
  return null;
}

/** Igual que extraerTextoPlano pero para text/html — se usa solo si no hay parte de texto plano. */
function extraerHtml(part: gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodificarBase64Url(part.body.data);
  }
  for (const sub of part.parts ?? []) {
    const encontrado = extraerHtml(sub);
    if (encontrado) return encontrado;
  }
  return null;
}

/** Conversión cruda de HTML a texto — suficiente para capturar contenido legible, no para renderizar. */
function htmlATexto(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/tr|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cuerpo COMPLETO del mensaje (no el snippet truncado de Gmail que usa
 * CorreoResumen.extracto) — prioriza text/plain; si el correo solo trae
 * HTML, lo convierte a texto plano. Se agregó porque capturar_correo
 * (registrar el contenido real de un correo en la base de conocimiento)
 * necesita el cuerpo entero, no un extracto de ~100 caracteres.
 */
export async function obtenerCuerpoCompletoCorreo(id: string): Promise<string> {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });

  const plano = extraerTextoPlano(res.data.payload);
  if (plano) return plano.trim();

  const html = extraerHtml(res.data.payload);
  if (html) return htmlATexto(html);

  return res.data.snippet ?? "";
}

function codificarHeaderAsunto(asunto: string): string {
  // Los headers RFC 2822 deben ir en ASCII; codificamos como UTF-8 base64
  // "encoded-word" si hay caracteres no ASCII (tildes, ñ, etc.).
  if (/^[\x00-\x7F]*$/.test(asunto)) return asunto;
  return `=?UTF-8?B?${Buffer.from(asunto, "utf-8").toString("base64")}?=`;
}

export interface AdjuntoParaEnviar {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * Construye el mensaje MIME completo como Buffer (no string) — necesario en
 * cuanto hay adjuntos binarios de por medio, para no arriesgar corromper los
 * bytes al pasar por una conversión a UTF-8 en algún punto. Sin adjuntos,
 * arma un mensaje simple text/plain como antes; con adjuntos, multipart/mixed
 * con el cuerpo como primera parte y cada adjunto codificado en base64.
 */
function construirMimeConAdjuntos(params: {
  to: string;
  asunto: string;
  cuerpo: string;
  messageIdHeader?: string;
  adjuntos?: AdjuntoParaEnviar[];
}): Buffer {
  // Solo se antepone "Re:" cuando es respuesta a un hilo existente
  // (messageIdHeader presente) — un correo nuevo debe llevar el asunto tal cual.
  const asuntoConRe =
    !params.messageIdHeader || /^re:/i.test(params.asunto.trim()) ? params.asunto : `Re: ${params.asunto}`;

  const headerLines = [`To: ${params.to}`, `Subject: ${codificarHeaderAsunto(asuntoConRe)}`, `MIME-Version: 1.0`];
  if (params.messageIdHeader) {
    headerLines.push(`In-Reply-To: ${params.messageIdHeader}`);
    headerLines.push(`References: ${params.messageIdHeader}`);
  }

  if (!params.adjuntos || params.adjuntos.length === 0) {
    headerLines.push(`Content-Type: text/plain; charset="UTF-8"`);
    return Buffer.from(`${headerLines.join("\r\n")}\r\n\r\n${params.cuerpo}`, "utf-8");
  }

  const boundary = `wobi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const partes: Buffer[] = [
    Buffer.from(`${headerLines.join("\r\n")}\r\n\r\n`, "utf-8"),
    Buffer.from(
      `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${params.cuerpo}\r\n\r\n`,
      "utf-8"
    ),
  ];

  for (const adjunto of params.adjuntos) {
    const base64 = adjunto.content.toString("base64").replace(/(.{76})/g, "$1\r\n");
    partes.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Type: ${adjunto.mimeType}; name="${adjunto.filename}"\r\n` +
          `Content-Disposition: attachment; filename="${adjunto.filename}"\r\n` +
          `Content-Transfer-Encoding: base64\r\n\r\n${base64}\r\n\r\n`,
        "utf-8"
      )
    );
  }
  partes.push(Buffer.from(`--${boundary}--`, "utf-8"));

  return Buffer.concat(partes);
}

function base64UrlEncodeBuffer(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Envía un correo por Gmail, opcionalmente con adjuntos (ej. reportes
 * generados) y enhebrado en el hilo original si se pasa
 * threadId/messageIdHeader. Solo debe llamarse desde el manejador del botón
 * "📤 Enviar así" (o el flujo de reportes programados, ya aprobado de
 * antemano al configurarlo) — nunca como reacción directa a un mensaje sin
 * que una persona lo haya confirmado.
 */
export async function enviarCorreo(params: {
  to: string;
  asunto: string;
  cuerpo: string;
  threadId?: string;
  messageIdHeader?: string;
  adjuntos?: AdjuntoParaEnviar[];
}): Promise<{ id: string; threadId: string }> {
  const gmail = getGmailSendClient();
  const raw = base64UrlEncodeBuffer(construirMimeConAdjuntos(params));

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: params.threadId || undefined,
    },
  });

  // No crítico — el correo ya se envió, esto solo alimenta el directorio.
  registrarPersonaDesdeCorreo(params.to, "correo_saliente").catch((error) =>
    console.error("[gmail/client] Error registrando destinatario en el directorio de personas:", error)
  );

  return { id: res.data.id ?? "", threadId: res.data.threadId ?? "" };
}

/** Descarga los bytes de un adjunto específico de un mensaje. */
export async function descargarAdjunto(messageId: string, attachmentId: string): Promise<Buffer> {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  return Buffer.from(res.data.data ?? "", "base64");
}
