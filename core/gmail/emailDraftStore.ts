import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

export interface BorradorCorreo {
  id: string;
  chatId: number;
  messageId: number;
  to: string;
  subject: string;
  threadId?: string;
  messageIdHeader?: string;
  cuerpo: string;
  creadoEn: number;
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_borradores_correo";
// Bug real encontrado en vivo (mismo patrón que classificationStore.ts y
// disambiguationStore.ts): este store vivía en un archivo JSON local, que
// se pierde en cada redeploy de Railway — un borrador de correo pendiente
// de aprobación podía desaparecer en silencio a mitad de una sesión de
// desarrollo activa. Migrado a Sheets, mismo patrón que el resto del
// proyecto.
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas, igual que antes

const HEADERS = ["id", "chatId", "messageId", "to", "subject", "threadId", "messageIdHeader", "cuerpo", "creadoEn"];

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
    throw new Error("No se pudo crear la pestaña de borradores de correo.");
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

function rowToBorrador(row: unknown[]): BorradorCorreo | null {
  if (!row[0]) return null;
  return {
    id: String(row[0]),
    chatId: Number(row[1]) || 0,
    messageId: Number(row[2]) || 0,
    to: row[3] ? String(row[3]) : "",
    subject: row[4] ? String(row[4]) : "",
    threadId: row[5] ? String(row[5]) : undefined,
    messageIdHeader: row[6] ? String(row[6]) : undefined,
    cuerpo: row[7] ? String(row[7]) : "",
    creadoEn: Number(row[8]) || 0,
  };
}

function borradorToRow(b: BorradorCorreo): (string | number)[] {
  return [b.id, b.chatId, b.messageId, b.to, b.subject, b.threadId ?? "", b.messageIdHeader ?? "", b.cuerpo, b.creadoEn];
}

interface FilaConIndice {
  rowIndex: number;
  borrador: BorradorCorreo;
}

async function leerTodos(): Promise<FilaConIndice[]> {
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
    const borrador = rowToBorrador(row);
    if (borrador) result.push({ rowIndex: i + 2, borrador });
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

async function purgarVencidos(): Promise<void> {
  const todos = await leerTodos();
  const ahora = Date.now();
  const vencidos = todos.filter(({ borrador }) => ahora - borrador.creadoEn > TTL_MS);

  vencidos.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidos) {
    await eliminarFila(rowIndex);
  }
}

export async function crearBorradorCorreo(
  datos: Omit<BorradorCorreo, "id" | "creadoEn">
): Promise<BorradorCorreo> {
  await purgarVencidos();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const borrador: BorradorCorreo = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:I`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [borradorToRow(borrador)] },
  });

  return borrador;
}

export async function actualizarMessageIdBorrador(id: string, messageId: number): Promise<void> {
  const todos = await leerTodos();
  const match = todos.find(({ borrador }) => borrador.id === id);
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

export async function actualizarCuerpoBorrador(id: string, cuerpo: string): Promise<BorradorCorreo | undefined> {
  const todos = await leerTodos();
  const match = todos.find(({ borrador }) => borrador.id === id);
  if (!match) return undefined;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!H${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[cuerpo]] },
  });

  return { ...match.borrador, cuerpo };
}

/**
 * Cuenta los borradores pendientes de aprobación (solo lectura, para
 * diagnóstico/dashboard).
 */
export async function contarBorradoresPendientes(): Promise<number> {
  await purgarVencidos();
  const todos = await leerTodos();
  return todos.length;
}

export async function obtenerBorradorCorreo(id: string): Promise<BorradorCorreo | undefined> {
  const todos = await leerTodos();
  return todos.find(({ borrador }) => borrador.id === id)?.borrador;
}

/** Devuelve el borrador y lo elimina (se llama al enviar o cancelar). */
export async function consumirBorradorCorreo(id: string): Promise<BorradorCorreo | undefined> {
  const todos = await leerTodos();
  const match = todos.find(({ borrador }) => borrador.id === id);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.borrador;
}
