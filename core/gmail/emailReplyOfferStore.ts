import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { conMutex } from "../utils/asyncMutex";
import type { IdentidadCorreoCola } from "./colaRevisionStore";

export interface OfertaResponderCorreo {
  id: string;
  chatId: number;
  messageId: number;
  de: string;
  asunto: string;
  threadId?: string;
  messageIdHeader?: string;
  /** Contexto para redactar la respuesta (ej. qué se archivó/capturó) — se pasa a generarBorradorYOfrecer. */
  contexto: string;
  /** Esta pregunta posee una decisión independiente del correo activo. */
  deColaCorreo?: boolean;
  /** Identidad durable y exacta de Gmail. Nunca se usa solo chatId para cerrar la cola. */
  correoThreadId?: string;
  correoMensajeId?: string;
  creadoEn: number;
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_ofertas_responder_correo";
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas, mismo criterio que el resto de propuestas de documentos/correo

const MUTEX_OFERTAS = "emailReplyOfferStore:transiciones";
const HEADERS = [
  "id",
  "chatId",
  "messageId",
  "de",
  "asunto",
  "threadId",
  "messageIdHeader",
  "contexto",
  "creadoEn",
  "deColaCorreo",
  "correoThreadId",
  "correoMensajeId",
];

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

let writeClient: sheets_v4.Sheets | null = null;
let tabGridId: number | null = null;

function getClient(): sheets_v4.Sheets {
  if (writeClient) return writeClient;

  const credentials = loadServiceAccountCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  writeClient = google.sheets({ version: "v4", auth });
  return writeClient;
}

async function ensureTab(): Promise<number> {
  if (tabGridId !== null) return tabGridId;

  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME);

  if (existing?.properties?.sheetId != null) {
    tabGridId = existing.properties.sheetId;
    // Migración aditiva para ofertas creadas antes de conservar la identidad
    // exacta de la cola. Las filas históricas quedan fuera de cola.
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A1:L1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
    return tabGridId;
  }

  const addResp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
  });

  const newSheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId == null) {
    throw new Error("No se pudo crear la pestaña de ofertas de responder correo.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:L1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToOferta(row: unknown[]): OfertaResponderCorreo | null {
  if (!row[0]) return null;
  return {
    id: String(row[0]),
    chatId: Number(row[1]) || 0,
    messageId: Number(row[2]) || 0,
    de: row[3] ? String(row[3]) : "",
    asunto: row[4] ? String(row[4]) : "",
    threadId: row[5] ? String(row[5]) : undefined,
    messageIdHeader: row[6] ? String(row[6]) : undefined,
    contexto: row[7] ? String(row[7]) : "",
    creadoEn: Number(row[8]) || 0,
    deColaCorreo: String(row[9] ?? "") === "true",
    correoThreadId: row[10] ? String(row[10]) : undefined,
    correoMensajeId: row[11] ? String(row[11]) : undefined,
  };
}

function ofertaToRow(o: OfertaResponderCorreo): (string | number)[] {
  return [
    o.id,
    o.chatId,
    o.messageId,
    o.de,
    o.asunto,
    o.threadId ?? "",
    o.messageIdHeader ?? "",
    o.contexto,
    o.creadoEn,
    o.deColaCorreo ? "true" : "",
    o.correoThreadId ?? "",
    o.correoMensajeId ?? "",
  ];
}

export interface FilaOfertaResponderConIndice {
  rowIndex: number;
  oferta: OfertaResponderCorreo;
}

async function leerTodas(): Promise<FilaOfertaResponderConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:L10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaOfertaResponderConIndice[] = [];
  rows.forEach((row, i) => {
    const oferta = rowToOferta(row);
    if (oferta) result.push({ rowIndex: i + 2, oferta });
  });
  return result;
}

async function eliminarFila(rowIndex1Based: number): Promise<void> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const gridId = await ensureTab();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId: gridId, dimension: "ROWS", startIndex: rowIndex1Based - 1, endIndex: rowIndex1Based },
          },
        },
      ],
    },
  });
}

async function purgarVencidasSinMutex(): Promise<void> {
  const todas = await leerTodas();
  const ahora = Date.now();
  // Una oferta de la cola posee una unidad real del contador. No puede
  // desaparecer por TTL porque dejaría el correo activo sin una acción
  // visible capaz de resolverlo. Se conserva hasta Sí/No.
  const vencidas = todas.filter(({ oferta }) => !oferta.deColaCorreo && ahora - oferta.creadoEn > TTL_MS);

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

export async function crearOfertaResponderCorreo(
  datos: Omit<OfertaResponderCorreo, "id" | "creadoEn">
): Promise<OfertaResponderCorreo> {
  return conMutex(MUTEX_OFERTAS, async () => {
    await purgarVencidasSinMutex();

    if (datos.deColaCorreo && (!datos.correoThreadId?.trim() || !datos.correoMensajeId?.trim())) {
      throw new Error("Una oferta de la cola requiere threadId y mensajeId de Gmail.");
    }

    const sheetId = assertSheetId();
    const sheets = getClient();
    await ensureTab();

    const oferta: OfertaResponderCorreo = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A:L`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [ofertaToRow(oferta)] },
    });

    return oferta;
  });
}

export async function actualizarMessageIdOfertaResponder(id: string, messageId: number): Promise<void> {
  await conMutex(MUTEX_OFERTAS, async () => {
    const todas = await leerTodas();
    const match = todas.find(({ oferta }) => oferta.id === id);
    if (!match) return;

    const sheetId = assertSheetId();
    const sheets = getClient();

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!C${match.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[messageId]] },
    });
  });
}

export function identidadCorreoDeOferta(
  oferta: Pick<OfertaResponderCorreo, "correoThreadId" | "correoMensajeId">
): Required<IdentidadCorreoCola> | undefined {
  const threadId = oferta.correoThreadId?.trim();
  const mensajeId = oferta.correoMensajeId?.trim();
  return threadId && mensajeId ? { threadId, mensajeId } : undefined;
}

export async function obtenerOfertaResponderCorreo(id: string): Promise<OfertaResponderCorreo | undefined> {
  const todas = await leerTodas();
  return todas.find(({ oferta }) => oferta.id === id)?.oferta;
}

/** Todas las ofertas visibles/persistidas del chat; el watchdog correlaciona
 * cada una con la identidad exacta del correo activo antes de usarla como
 * señal de que el proceso está esperando al operador. */
export async function obtenerOfertasResponderCorreoPorChat(chatId: number): Promise<OfertaResponderCorreo[]> {
  const todas = await leerTodas();
  return todas
    .filter(({ oferta }) => oferta.chatId === chatId && oferta.messageId > 0)
    .map(({ oferta }) => oferta);
}

export async function obtenerOfertaResponderPorCorreo(
  chatId: number,
  identidad: Required<IdentidadCorreoCola>
): Promise<OfertaResponderCorreo | undefined> {
  const todas = await leerTodas();
  return todas.find(({ oferta }) =>
    oferta.chatId === chatId &&
    oferta.deColaCorreo === true &&
    oferta.correoThreadId === identidad.threadId &&
    oferta.correoMensajeId === identidad.mensajeId
  )?.oferta;
}

export interface DependenciasConsumoOfertaResponder {
  leer: () => Promise<FilaOfertaResponderConIndice[]>;
  eliminar: (rowIndex: number) => Promise<void>;
}

/** Primitivo probado: dos toques concurrentes solo pueden reclamar una vez. */
export async function consumirOfertaResponderUnaVez(
  id: string,
  dependencias: DependenciasConsumoOfertaResponder = { leer: leerTodas, eliminar: eliminarFila },
  claveMutex = MUTEX_OFERTAS
): Promise<OfertaResponderCorreo | undefined> {
  return conMutex(claveMutex, async () => {
    const todas = await dependencias.leer();
    const match = todas.find(({ oferta }) => oferta.id === id);
    if (!match) return undefined;

    await dependencias.eliminar(match.rowIndex);
    return match.oferta;
  });
}

/** Devuelve la oferta y la elimina (se responda que sí o que no). */
export async function consumirOfertaResponderCorreo(id: string): Promise<OfertaResponderCorreo | undefined> {
  return consumirOfertaResponderUnaVez(id);
}

/** Restaura el mismo id tras un fallo intermedio, preservando la idempotencia del botón. */
export async function restaurarOfertaResponderCorreo(oferta: OfertaResponderCorreo): Promise<void> {
  await conMutex(MUTEX_OFERTAS, async () => {
    const todas = await leerTodas();
    if (todas.some(({ oferta: existente }) => existente.id === oferta.id)) return;

    await getClient().spreadsheets.values.append({
      spreadsheetId: assertSheetId(),
      range: `${TAB_NAME}!A:L`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [ofertaToRow(oferta)] },
    });
  });
}
