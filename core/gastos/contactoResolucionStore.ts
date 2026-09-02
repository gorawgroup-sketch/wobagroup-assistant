import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import type { PropuestaGasto } from "./gastoProposalSheet";

export interface AlternativaContacto {
  contactId: string;
  contactName: string;
  motivo: "nombre_parecido" | "mismo_importe";
  detalle?: string;
}

export interface ResolucionContactoPendiente {
  id: string;
  propuesta: PropuestaGasto;
  empresaFinal: PropuestaGasto["empresa"];
  conceptoFinal: string;
  alternativas: AlternativaContacto[];
  /** Mensaje que muestra los botones de alternativas — puede ser distinto de propuesta.messageId. */
  chatId: number;
  messageId: number;
  creadoEn: number;
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_resoluciones_contacto_gasto";
// Bug real encontrado en vivo (mismo patrón que classificationStore.ts,
// disambiguationStore.ts y emailDraftStore.ts): este store vivía en un
// archivo JSON local, que se pierde en cada redeploy. Migrado a Sheets.
// 24h — pedido explícito de Carlos (mismo criterio en todos los
// "pendiente_*", ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

const HEADERS = ["id", "propuestaJSON", "empresaFinal", "conceptoFinal", "alternativasJSON", "chatId", "messageId", "creadoEn"];

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
    throw new Error("No se pudo crear la pestaña de resoluciones de contacto.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:H1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToResolucion(row: unknown[]): ResolucionContactoPendiente | null {
  if (!row[0]) return null;

  let propuesta: PropuestaGasto;
  let alternativas: AlternativaContacto[];
  try {
    propuesta = row[1] ? JSON.parse(String(row[1])) : null;
    alternativas = row[4] ? JSON.parse(String(row[4])) : [];
  } catch {
    return null; // fila corrupta — mejor ignorarla que tumbar el resto
  }
  if (!propuesta) return null;

  return {
    id: String(row[0]),
    propuesta,
    empresaFinal: row[2] as ResolucionContactoPendiente["empresaFinal"],
    conceptoFinal: row[3] ? String(row[3]) : "",
    alternativas,
    chatId: Number(row[5]) || 0,
    messageId: Number(row[6]) || 0,
    creadoEn: Number(row[7]) || 0,
  };
}

function resolucionToRow(r: ResolucionContactoPendiente): (string | number)[] {
  return [
    r.id,
    JSON.stringify(r.propuesta),
    r.empresaFinal,
    r.conceptoFinal,
    JSON.stringify(r.alternativas),
    r.chatId,
    r.messageId,
    r.creadoEn,
  ];
}

interface FilaConIndice {
  rowIndex: number;
  resolucion: ResolucionContactoPendiente;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:H10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    const resolucion = rowToResolucion(row);
    if (resolucion) result.push({ rowIndex: i + 2, resolucion });
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
  const vencidas = todas.filter(({ resolucion }) => ahora - resolucion.creadoEn > TTL_MS);

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

export async function guardarResolucionContacto(
  datos: Omit<ResolucionContactoPendiente, "id" | "creadoEn">
): Promise<ResolucionContactoPendiente> {
  await purgarVencidas();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const resolucion: ResolucionContactoPendiente = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:H`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [resolucionToRow(resolucion)] },
  });

  return resolucion;
}

export async function consumirResolucionContacto(id: string): Promise<ResolucionContactoPendiente | undefined> {
  const todas = await leerTodas();
  const match = todas.find(({ resolucion }) => resolucion.id === id);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.resolucion;
}

/**
 * Igual que consumirResolucionContacto, pero busca por chatId — para cuando
 * el usuario responde en texto libre ("ya lo creé") en vez de tocar un
 * botón. Pedido explícito de Carlos: reconocer la pregunta pendiente,
 * integrar la respuesta, y seguir adelante con el proceso, sin que tenga
 * que reenviar la factura. Si hay varias del mismo chat, consume la más
 * reciente.
 */
export async function consumirResolucionContactoPorChat(chatId: number): Promise<ResolucionContactoPendiente | undefined> {
  const todas = await leerTodas();
  const delChat = todas.filter(({ resolucion }) => resolucion.chatId === chatId);
  if (delChat.length === 0) return undefined;

  const masReciente = delChat.reduce((a, b) => (a.resolucion.creadoEn >= b.resolucion.creadoEn ? a : b));
  await eliminarFila(masReciente.rowIndex);
  return masReciente.resolucion;
}

/** Solo lectura (no consume) — para que el asistente conversacional sepa que hay una resolución de contacto pendiente ANTES de decidir qué hacer con el mensaje del usuario. */
export async function obtenerResolucionContactoPendientePorChat(chatId: number): Promise<ResolucionContactoPendiente | undefined> {
  const todas = await leerTodas();
  const delChat = todas.filter(({ resolucion }) => resolucion.chatId === chatId);
  if (delChat.length === 0) return undefined;

  return delChat.reduce((a, b) => (a.resolucion.creadoEn >= b.resolucion.creadoEn ? a : b)).resolucion;
}

/**
 * Actualiza el messageId de una resolución ya guardada — para el caso en
 * que se guarda ANTES de mandar el mensaje con botones (no había un
 * messageId previo editable) y hace falta registrar el id real después de
 * enviarlo, igual que actualizarMessageIdGasto en gastoProposalSheet.ts.
 */
export async function actualizarMessageIdResolucionContacto(id: string, messageId: number): Promise<void> {
  const todas = await leerTodas();
  const match = todas.find(({ resolucion }) => resolucion.id === id);
  if (!match) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!G${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[messageId]] },
  });
}
