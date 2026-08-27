import { randomBytes } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_cerebro_tokens_temporales";
const HORAS_VALIDEZ_DEFECTO = 24;

/**
 * Tokens temporales de acceso al front del cerebro — alternativa a repartir
 * la CEREBRO_API_KEY maestra cuando un admin aprueba una solicitud "solo
 * temporal" (ver accesoCallbackHandler.ts). Cada token es de un solo uso
 * como credencial de sesión (no de un solo request — sirve para todas las
 * llamadas a /api/cerebro/estado hasta que expira), con vencimiento.
 */
function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

let writeClient: sheets_v4.Sheets | null = null;

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
  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:D1`,
    valueInputOption: "RAW",
    requestBody: { values: [["token", "nombre", "creadoEn", "expiraEn"]] },
  });
}

/** Cachea en memoria de proceso los tokens vigentes ya vistos, para no pegarle a Sheets en cada request al endpoint de datos. */
const cacheVigentes = new Map<string, number>(); // token -> expiraEn (unix ms)
let cacheCargadaEn = 0;
const CACHE_TTL_MS = 60 * 1000;

async function cargarCacheSiHaceFalta(): Promise<void> {
  if (Date.now() - cacheCargadaEn < CACHE_TTL_MS) return;

  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:D10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  cacheVigentes.clear();
  const ahora = Date.now();
  for (const row of rows) {
    const token = row[0] ? String(row[0]) : "";
    const expiraEn = Number(row[3]) || 0;
    if (token && expiraEn > ahora) cacheVigentes.set(token, expiraEn);
  }
  cacheCargadaEn = ahora;
}

export async function crearTokenTemporal(nombre: string, horasValidez = HORAS_VALIDEZ_DEFECTO): Promise<{ token: string; expiraEn: number }> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const token = randomBytes(24).toString("hex");
  const creadoEn = Date.now();
  const expiraEn = creadoEn + horasValidez * 60 * 60 * 1000;

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:D`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[token, nombre, creadoEn, expiraEn]] },
  });

  cacheVigentes.set(token, expiraEn);

  return { token, expiraEn };
}

/** true si el token existe y no ha vencido. Cachea la lista de vigentes ~60s para no pegarle a Sheets en cada request. */
export async function esTokenTemporalValido(token: string): Promise<boolean> {
  if (!token) return false;

  await cargarCacheSiHaceFalta();
  const expiraEn = cacheVigentes.get(token);
  return !!expiraEn && expiraEn > Date.now();
}
