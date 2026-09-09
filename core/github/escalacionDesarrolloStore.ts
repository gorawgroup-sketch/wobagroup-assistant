import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

export interface EscalacionDesarrollo {
  id: string;
  chatId: number;
  messageId: number;
  titulo: string;
  cuerpo: string;
  urgente: boolean;
  creadoEn: number;
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_escalaciones_development";
// Mismo patrón que emailDraftStore.ts (Sheets, no un archivo local) — una propuesta de escalación
// pendiente de aprobación no debe desaparecer en silencio si Railway redeploya entre proponerla y
// aprobarla.
const TTL_MS = 48 * 60 * 60 * 1000;

const HEADERS = ["id", "chatId", "messageId", "titulo", "cuerpo", "urgente", "creadoEn"];

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
    throw new Error("No se pudo crear la pestaña de escalaciones a development.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:G1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToEscalacion(row: unknown[]): EscalacionDesarrollo | null {
  if (!row[0]) return null;
  return {
    id: String(row[0]),
    chatId: Number(row[1]) || 0,
    messageId: Number(row[2]) || 0,
    titulo: row[3] ? String(row[3]) : "",
    cuerpo: row[4] ? String(row[4]) : "",
    urgente: row[5] === true || row[5] === "true",
    creadoEn: Number(row[6]) || 0,
  };
}

function escalacionToRow(e: EscalacionDesarrollo): (string | number | boolean)[] {
  return [e.id, e.chatId, e.messageId, e.titulo, e.cuerpo, e.urgente, e.creadoEn];
}

interface FilaConIndice {
  rowIndex: number;
  escalacion: EscalacionDesarrollo;
}

async function leerTodos(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:G10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    const escalacion = rowToEscalacion(row);
    if (escalacion) result.push({ rowIndex: i + 2, escalacion });
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
  const vencidos = todos.filter(({ escalacion }) => ahora - escalacion.creadoEn > TTL_MS);

  vencidos.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidos) {
    await eliminarFila(rowIndex);
  }
}

export async function crearEscalacionDesarrollo(
  datos: Omit<EscalacionDesarrollo, "id" | "creadoEn">
): Promise<EscalacionDesarrollo> {
  await purgarVencidos();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const escalacion: EscalacionDesarrollo = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:G`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [escalacionToRow(escalacion)] },
  });

  return escalacion;
}

export async function actualizarMessageIdEscalacion(id: string, messageId: number): Promise<void> {
  const todos = await leerTodos();
  const match = todos.find(({ escalacion }) => escalacion.id === id);
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

export async function obtenerEscalacionDesarrollo(id: string): Promise<EscalacionDesarrollo | undefined> {
  const todos = await leerTodos();
  return todos.find(({ escalacion }) => escalacion.id === id)?.escalacion;
}

/** Devuelve la escalación y la elimina (se llama al crear el issue o al cancelar). */
export async function consumirEscalacionDesarrollo(id: string): Promise<EscalacionDesarrollo | undefined> {
  const todos = await leerTodos();
  const match = todos.find(({ escalacion }) => escalacion.id === id);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.escalacion;
}
