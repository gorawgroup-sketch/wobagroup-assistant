import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "./serviceAccount";
import type { BloqueEscritura } from "./cashflowWrite";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_propuestas_pendientes";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

const HEADERS = [
  "id",
  "empresa",
  "bloqueSugerido",
  "clienteOConcepto",
  "semana",
  "valor",
  "fechaMovimiento",
  "chatId",
  "messageId",
  "creadoEn",
];

export interface Propuesta {
  id: string;
  empresa: "WOBA" | "EWORKS";
  bloqueSugerido: BloqueEscritura;
  clienteOConcepto: string;
  semana: string;
  valor: number;
  fechaMovimiento?: string;
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

/**
 * Asegura que exista la pestaña oculta de propuestas pendientes (la crea con
 * encabezados si no existe) y devuelve su sheetId numérico (necesario para
 * borrar filas por índice).
 */
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
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }],
    },
  });

  const newSheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId == null) {
    throw new Error("No se pudo crear la pestaña de propuestas pendientes.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:J1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToPropuesta(row: unknown[]): Propuesta | null {
  if (!row[0]) return null;

  return {
    id: String(row[0]),
    empresa: row[1] as "WOBA" | "EWORKS",
    bloqueSugerido: row[2] as BloqueEscritura,
    clienteOConcepto: row[3] ? String(row[3]) : "",
    semana: row[4] ? String(row[4]) : "",
    valor: Number(row[5]) || 0,
    fechaMovimiento: row[6] ? String(row[6]) : undefined,
    chatId: Number(row[7]) || 0,
    messageId: Number(row[8]) || 0,
    creadoEn: Number(row[9]) || 0,
  };
}

function propuestaToRow(p: Propuesta): (string | number)[] {
  return [
    p.id,
    p.empresa,
    p.bloqueSugerido,
    p.clienteOConcepto,
    p.semana,
    p.valor,
    p.fechaMovimiento ?? "",
    p.chatId,
    p.messageId,
    p.creadoEn,
  ];
}

interface FilaConIndice {
  rowIndex: number; // fila real en la hoja (1-indexado, ya cuenta el header)
  propuesta: Propuesta;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:J10000`,
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
            range: {
              sheetId: gridId,
              dimension: "ROWS",
              startIndex: rowIndex1Based - 1,
              endIndex: rowIndex1Based,
            },
          },
        },
      ],
    },
  });
}

/**
 * Borra propuestas vencidas (+7 días sin resolver) de la pestaña, para que
 * nunca se acumule basura ahí aunque nadie responda un botón. Se llama en
 * cada lectura/escritura, así que la pestaña se mantiene al día sola.
 */
async function purgarVencidas(): Promise<void> {
  const todas = await leerTodas();
  const ahora = Date.now();
  const vencidas = todas.filter(({ propuesta }) => ahora - propuesta.creadoEn > TTL_MS);

  // De abajo hacia arriba para que borrar una fila no corra los índices de las siguientes.
  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

export async function crearPropuesta(datos: Omit<Propuesta, "id" | "creadoEn">): Promise<Propuesta> {
  await purgarVencidas();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const propuesta: Propuesta = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [propuestaToRow(propuesta)] },
  });

  return propuesta;
}

/** Actualiza el message_id real de Telegram tras enviar el mensaje (se crea la fila antes de conocerlo). */
export async function actualizarMessageId(id: string, messageId: number): Promise<void> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!I${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[messageId]] },
  });
}

/** Lista todas las propuestas pendientes SIN consumirlas (solo lectura, para diagnóstico/dashboard). */
export async function listarPropuestasPendientes(): Promise<Propuesta[]> {
  await purgarVencidas();
  const todas = await leerTodas();
  return todas.map(({ propuesta }) => propuesta);
}

export async function obtenerPropuesta(id: string): Promise<Propuesta | undefined> {
  await purgarVencidas();
  const todas = await leerTodas();
  return todas.find(({ propuesta }) => propuesta.id === id)?.propuesta;
}

/**
 * Devuelve la propuesta y ELIMINA su fila de inmediato (aprobada o
 * ignorada, ya no debe quedar registro en la pestaña).
 */
export async function consumirPropuesta(id: string): Promise<Propuesta | undefined> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.propuesta;
}
