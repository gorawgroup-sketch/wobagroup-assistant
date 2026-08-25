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

export interface AdjuntoCorreo {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface CorreoResumen {
  id: string;
  threadId: string;
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

/** Trae metadatos + extracto + lista de adjuntos de un mensaje. */
export async function obtenerResumenCorreo(id: string): Promise<CorreoResumen> {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const msg = res.data;

  return {
    id: msg.id ?? id,
    threadId: msg.threadId ?? "",
    de: leerHeader(msg.payload?.headers, "From"),
    asunto: leerHeader(msg.payload?.headers, "Subject"),
    fecha: leerHeader(msg.payload?.headers, "Date"),
    extracto: msg.snippet ?? "",
    adjuntos: extraerAdjuntos(msg.payload),
  };
}

/** Descarga los bytes de un adjunto específico de un mensaje. */
export async function descargarAdjunto(messageId: string, attachmentId: string): Promise<Buffer> {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  return Buffer.from(res.data.data ?? "", "base64");
}
