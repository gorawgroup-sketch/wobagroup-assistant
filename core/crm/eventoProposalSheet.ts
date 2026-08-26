import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import type { Empresa } from "../holded/client";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_eventos_pendientes";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días, igual que las demás propuestas

const HEADERS = [
  "id",
  "empresa",
  "nombre",
  "tipo",
  "descripcion",
  "fechaInicio",
  "fechaFin",
  "contactId",
  "contactNombre",
  "ubicacion",
  "chatId",
  "messageId",
  "creadoEn",
];

export interface PropuestaEvento {
  id: string;
  empresa: Empresa;
  nombre: string;
  tipo: string;
  descripcion: string;
  /** "YYYY-MM-DDTHH:mm:ss" en hora local Madrid — ver crearEventoHolded. */
  fechaInicio: string;
  fechaFin: string;
  contactId?: string;
  contactNombre?: string;
  ubicacion: string;
  chatId: number;
  messageId: number;
  creadoEn: number;
}

let writeClient: sheets_v4.Sheets | null = null;
let tabGridId: number | null = null;

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

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
    throw new Error("No se pudo crear la pestaña de eventos pendientes.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:M1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToPropuesta(row: unknown[]): PropuestaEvento | null {
  if (!row[0]) return null;

  return {
    id: String(row[0]),
    empresa: row[1] as Empresa,
    nombre: row[2] ? String(row[2]) : "",
    tipo: row[3] ? String(row[3]) : "recordatorio",
    descripcion: row[4] ? String(row[4]) : "",
    fechaInicio: row[5] ? String(row[5]) : "",
    fechaFin: row[6] ? String(row[6]) : "",
    contactId: row[7] ? String(row[7]) : undefined,
    contactNombre: row[8] ? String(row[8]) : undefined,
    ubicacion: row[9] ? String(row[9]) : "",
    chatId: Number(row[10]) || 0,
    messageId: Number(row[11]) || 0,
    creadoEn: Number(row[12]) || 0,
  };
}

function propuestaToRow(p: PropuestaEvento): (string | number)[] {
  return [
    p.id,
    p.empresa,
    p.nombre,
    p.tipo,
    p.descripcion,
    p.fechaInicio,
    p.fechaFin,
    p.contactId ?? "",
    p.contactNombre ?? "",
    p.ubicacion,
    p.chatId,
    p.messageId,
    p.creadoEn,
  ];
}

interface FilaConIndice {
  rowIndex: number;
  propuesta: PropuestaEvento;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:M10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    const propuesta = rowToPropuesta(row);
    if (propuesta) result.push({ rowIndex: i + 2, propuesta });
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
  const vencidas = todas.filter(({ propuesta }) => ahora - propuesta.creadoEn > TTL_MS);

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

export async function crearPropuestaEvento(datos: Omit<PropuestaEvento, "id" | "creadoEn">): Promise<PropuestaEvento> {
  await purgarVencidas();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const propuesta: PropuestaEvento = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:M`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [propuestaToRow(propuesta)] },
  });

  return propuesta;
}

export async function actualizarMessageIdEvento(id: string, messageId: number): Promise<void> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!L${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[messageId]] },
  });
}

/** Devuelve la propuesta y ELIMINA su fila de inmediato (aprobada o descartada). */
export async function consumirPropuestaEvento(id: string): Promise<PropuestaEvento | undefined> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.propuesta;
}
