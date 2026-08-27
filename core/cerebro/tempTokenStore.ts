import { randomBytes, randomUUID } from "node:crypto";
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
 * llamadas a /api/cerebro/estado hasta que expira o se revoca). El front
 * lo guarda en localStorage y lo reintenta solo — nunca vuelve a pedir
 * acceso mientras el token siga siendo válido aquí.
 */
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

const HEADERS = ["id", "token", "nombre", "creadoEn", "expiraEn"];

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
    throw new Error("No se pudo crear la pestaña de tokens temporales del cerebro.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:E1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

export interface TokenTemporalActivo {
  id: string;
  nombre: string;
  creadoEn: number;
  expiraEn: number;
}

interface FilaToken extends TokenTemporalActivo {
  token: string;
}

interface FilaConIndice {
  rowIndex: number;
  fila: FilaToken;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:E10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    if (!row[0]) return;
    result.push({
      rowIndex: i + 2,
      fila: {
        id: String(row[0]),
        token: row[1] ? String(row[1]) : "",
        nombre: row[2] ? String(row[2]) : "",
        creadoEn: Number(row[3]) || 0,
        expiraEn: Number(row[4]) || 0,
      },
    });
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

/** Cachea en memoria de proceso los tokens vigentes ya vistos, para no pegarle a Sheets en cada request al endpoint de datos. */
const cacheVigentes = new Map<string, number>(); // token -> expiraEn (unix ms)
let cacheCargadaEn = 0;
const CACHE_TTL_MS = 60 * 1000;

async function cargarCacheSiHaceFalta(forzar = false): Promise<void> {
  if (!forzar && Date.now() - cacheCargadaEn < CACHE_TTL_MS) return;

  const todas = await leerTodas();
  cacheVigentes.clear();
  const ahora = Date.now();
  for (const { fila } of todas) {
    if (fila.token && fila.expiraEn > ahora) cacheVigentes.set(fila.token, fila.expiraEn);
  }
  cacheCargadaEn = ahora;
}

export async function crearTokenTemporal(nombre: string, horasValidez = HORAS_VALIDEZ_DEFECTO): Promise<{ token: string; expiraEn: number }> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const id = randomUUID().slice(0, 8);
  const token = randomBytes(24).toString("hex");
  const creadoEn = Date.now();
  const expiraEn = creadoEn + horasValidez * 60 * 60 * 1000;

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:E`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[id, token, nombre, creadoEn, expiraEn]] },
  });

  cacheVigentes.set(token, expiraEn);

  return { token, expiraEn };
}

/** true si el token existe, no ha vencido, y no fue revocado. Cachea la lista de vigentes ~60s para no pegarle a Sheets en cada request. */
export async function esTokenTemporalValido(token: string): Promise<boolean> {
  if (!token) return false;

  await cargarCacheSiHaceFalta();
  const expiraEn = cacheVigentes.get(token);
  return !!expiraEn && expiraEn > Date.now();
}

/** Lista los tokens vigentes (sin revelar el valor del token) — para el panel de admin. */
export async function listarTokensActivos(): Promise<TokenTemporalActivo[]> {
  const todas = await leerTodas();
  const ahora = Date.now();
  return todas
    .filter(({ fila }) => fila.expiraEn > ahora)
    .map(({ fila }) => ({ id: fila.id, nombre: fila.nombre, creadoEn: fila.creadoEn, expiraEn: fila.expiraEn }))
    .sort((a, b) => b.creadoEn - a.creadoEn);
}

/** Revoca un token temporal por id (lo borra de la hoja y de la caché) — true si existía. */
export async function revocarTokenTemporal(id: string): Promise<boolean> {
  const todas = await leerTodas();
  const match = todas.find(({ fila }) => fila.id === id);
  if (!match) return false;

  await eliminarFila(match.rowIndex);
  cacheVigentes.delete(match.fila.token);

  return true;
}
