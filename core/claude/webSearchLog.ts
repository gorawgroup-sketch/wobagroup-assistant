import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { PRECIO_POR_BUSQUEDA_WEB } from "./costTracking";

/**
 * Pedido explícito de Carlos: no solo saber que la búsqueda web "está
 * conectada" (ver core/cerebro/conexiones.ts), sino QUÉ búsquedas se han
 * hecho y QUÉ costo tuvieron, de forma independiente — cada fila es UNA
 * búsqueda real, con su consulta exacta, cuántos resultados trajo, y su
 * costo (mismo precio unitario que ya usa costTracking.ts para el total
 * agregado, ver PRECIO_POR_BUSQUEDA_WEB, importado de ahí para no duplicar
 * el número). costTracking.ts sigue siendo la fuente del costo TOTAL de IA
 * (tokens + búsquedas mezclados); esta pestaña es solo el desglose de las
 * búsquedas en sí, para el panel de búsqueda web del front.
 */
const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_busquedas_web";
const HEADERS = ["fecha", "chatId", "origen", "query", "numResultados", "costoUSD"];

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

let writeClient: sheets_v4.Sheets | null = null;
let tabAsegurada = false;

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

async function ensureTab(): Promise<void> {
  if (tabAsegurada) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME);
  if (existing) {
    tabAsegurada = true;
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:F1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

export interface RegistroBusquedaWeb {
  fecha: string;
  chatId: number | "";
  /** "chat": vino de una conversación real de Telegram. "panel": alguien la disparó desde el buscador del front /cerebro. */
  origen: "chat" | "panel";
  query: string;
  numResultados: number;
  costoUSD: number;
}

/** Registra UNA búsqueda real ya ejecutada — nunca dispara la búsqueda, solo deja constancia de una que ya ocurrió. */
export async function registrarBusquedaWeb(
  chatId: number | undefined,
  origen: "chat" | "panel",
  query: string,
  numResultados: number
): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:F`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[new Date().toISOString(), chatId ?? "", origen, query, numResultados, PRECIO_POR_BUSQUEDA_WEB]],
    },
  });
}

async function leerTodas(): Promise<RegistroBusquedaWeb[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:F200000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      fecha: String(row[0]),
      chatId: row[1] === "" || row[1] == null ? "" : Number(row[1]),
      origen: row[2] === "panel" ? "panel" : "chat",
      query: row[3] ? String(row[3]) : "",
      numResultados: Number(row[4]) || 0,
      costoUSD: Number(row[5]) || 0,
    }));
}

/** Las N búsquedas más recientes, más nuevas primero — para el panel de búsqueda web del front. */
export async function obtenerBusquedasRecientes(limite = 20): Promise<RegistroBusquedaWeb[]> {
  const todas = await leerTodas();
  return todas.slice(-limite).reverse();
}

export interface ResumenBusquedasWeb {
  totalBusquedas: number;
  costoTotalUSD: number;
  busquedasHoy: number;
  costoHoyUSD: number;
}

/** Totales generales + de hoy, para mostrar junto al panel sin tener que sumar cada fila en el front. */
export async function obtenerResumenBusquedasWeb(): Promise<ResumenBusquedasWeb> {
  const todas = await leerTodas();
  const hoyNorm = new Date();
  hoyNorm.setHours(0, 0, 0, 0);

  const deHoy = todas.filter((r) => new Date(r.fecha) >= hoyNorm);

  return {
    totalBusquedas: todas.length,
    costoTotalUSD: todas.reduce((acc, r) => acc + r.costoUSD, 0),
    busquedasHoy: deHoy.length,
    costoHoyUSD: deHoy.reduce((acc, r) => acc + r.costoUSD, 0),
  };
}
