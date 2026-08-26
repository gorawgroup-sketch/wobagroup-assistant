import { google, gmail_v1 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

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

/** Cuenta los mensajes no leídos de la bandeja de entrada (estimado de Gmail, sin paginar todo). */
export async function contarNoLeidos(): Promise<number> {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.list({ userId: "me", q: "is:unread in:inbox", maxResults: 1 });
  return res.data.resultSizeEstimate ?? 0;
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

function codificarHeaderAsunto(asunto: string): string {
  // Los headers RFC 2822 deben ir en ASCII; codificamos como UTF-8 base64
  // "encoded-word" si hay caracteres no ASCII (tildes, ñ, etc.).
  if (/^[\x00-\x7F]*$/.test(asunto)) return asunto;
  return `=?UTF-8?B?${Buffer.from(asunto, "utf-8").toString("base64")}?=`;
}

function construirMimeRespuesta(params: {
  to: string;
  asunto: string;
  cuerpo: string;
  messageIdHeader?: string;
}): string {
  // Solo se antepone "Re:" cuando es respuesta a un hilo existente
  // (messageIdHeader presente) — un correo nuevo debe llevar el asunto tal cual.
  const asuntoConRe =
    !params.messageIdHeader || /^re:/i.test(params.asunto.trim()) ? params.asunto : `Re: ${params.asunto}`;

  const headers = [
    `To: ${params.to}`,
    `Subject: ${codificarHeaderAsunto(asuntoConRe)}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `MIME-Version: 1.0`,
  ];

  if (params.messageIdHeader) {
    headers.push(`In-Reply-To: ${params.messageIdHeader}`);
    headers.push(`References: ${params.messageIdHeader}`);
  }

  return `${headers.join("\r\n")}\r\n\r\n${params.cuerpo}`;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Envía una respuesta por Gmail, enhebrada en el hilo original si se pasa
 * threadId/messageIdHeader. Solo debe llamarse desde el manejador del botón
 * "📤 Enviar así" — nunca automáticamente.
 */
export async function enviarCorreo(params: {
  to: string;
  asunto: string;
  cuerpo: string;
  threadId?: string;
  messageIdHeader?: string;
}): Promise<{ id: string; threadId: string }> {
  const gmail = getGmailSendClient();
  const raw = base64UrlEncode(construirMimeRespuesta(params));

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: params.threadId || undefined,
    },
  });

  return { id: res.data.id ?? "", threadId: res.data.threadId ?? "" };
}

/** Descarga los bytes de un adjunto específico de un mensaje. */
export async function descargarAdjunto(messageId: string, attachmentId: string): Promise<Buffer> {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  return Buffer.from(res.data.data ?? "", "base64");
}
