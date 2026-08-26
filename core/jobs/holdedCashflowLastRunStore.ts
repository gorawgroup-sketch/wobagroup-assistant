import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_holded_cashflow_ultimo_check";

/**
 * Guarda el timestamp de la última vez que corrió revisarHoldedVsCashflow
 * (cualquiera de los dos modos, cierre semanal o chequeo preliminar) en una
 * pestaña oculta del Sheet de cashflow — mismo patrón que
 * core/gmail/lastCheckStore.ts. Antes no existía ningún registro de esto (el
 * cron solo escribía a console.log); se agregó el 2026-08-26 para que el
 * endpoint /api/cerebro/estado tenga un dato real en vez de null.
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
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }],
    },
  });
}

/** Timestamp (unix seconds) de la última corrida, o undefined si nunca corrió. */
export async function obtenerUltimoRunHoldedCashflow(): Promise<number | undefined> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const valor = resp.data.values?.[0]?.[0];
  return typeof valor === "number" && valor > 0 ? valor : undefined;
}

export async function guardarUltimoRunHoldedCashflow(timestampUnixSeconds: number): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [[timestampUnixSeconds]] },
  });
}
