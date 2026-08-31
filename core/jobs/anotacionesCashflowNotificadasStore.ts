import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_anotaciones_cashflow_notificadas";
const HEADERS = ["commentId", "modificado", "notificadoEn"];

/**
 * Registro de qué comentarios del cashflow (ver cashflowComments.ts) ya se
 * avisaron por Telegram — sin esto, revisarAnotacionesCashflow reenviaría
 * el mismo aviso todos los días mientras el comentario siga sin
 * resolverse, a diferencia de las alertas fiscales (que sí repiten porque
 * tienen una ventana de días fija antes del vencimiento). Se guarda
 * también `modificado` (modifiedTime del comentario) para que una EDICIÓN
 * del comentario sí dispare un aviso nuevo, no solo su creación.
 */
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
    range: `${TAB_NAME}!A1:C1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

/** Mapa commentId -> modifiedTime ya notificado. */
export async function obtenerAnotacionesYaNotificadas(): Promise<Map<string, string>> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:B10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const mapa = new Map<string, string>();
  for (const row of resp.data.values ?? []) {
    if (row[0]) mapa.set(String(row[0]), row[1] ? String(row[1]) : "");
  }
  return mapa;
}

export async function marcarAnotacionNotificada(commentId: string, modificado: string): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:C`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[commentId, modificado, new Date().toISOString()]] },
  });
}
