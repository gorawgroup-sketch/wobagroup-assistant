import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

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
  creadoEn: number;
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_ofertas_responder_correo";
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas, mismo criterio que el resto de propuestas de documentos/correo

const HEADERS = ["id", "chatId", "messageId", "de", "asunto", "threadId", "messageIdHeader", "contexto", "creadoEn"];

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
    range: `${TAB_NAME}!A1:I1`,
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
  };
}

function ofertaToRow(o: OfertaResponderCorreo): (string | number)[] {
  return [o.id, o.chatId, o.messageId, o.de, o.asunto, o.threadId ?? "", o.messageIdHeader ?? "", o.contexto, o.creadoEn];
}

interface FilaConIndice {
  rowIndex: number;
  oferta: OfertaResponderCorreo;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:I10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
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

async function purgarVencidas(): Promise<void> {
  const todas = await leerTodas();
  const ahora = Date.now();
  const vencidas = todas.filter(({ oferta }) => ahora - oferta.creadoEn > TTL_MS);

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

export async function crearOfertaResponderCorreo(
  datos: Omit<OfertaResponderCorreo, "id" | "creadoEn">
): Promise<OfertaResponderCorreo> {
  await purgarVencidas();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const oferta: OfertaResponderCorreo = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:I`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [ofertaToRow(oferta)] },
  });

  return oferta;
}

export async function actualizarMessageIdOfertaResponder(id: string, messageId: number): Promise<void> {
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
}

/** Devuelve la oferta y la elimina (se responda que sí o que no). */
export async function consumirOfertaResponderCorreo(id: string): Promise<OfertaResponderCorreo | undefined> {
  const todas = await leerTodas();
  const match = todas.find(({ oferta }) => oferta.id === id);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.oferta;
}
