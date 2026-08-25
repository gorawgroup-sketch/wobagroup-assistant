import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_gmail_ultimo_check";

// La primera vez que corre (sin estado previo), solo mira las últimas 24h
// hacia atrás — evita procesar años de historial del buzón.
const VENTANA_INICIAL_HORAS = 24;

/**
 * Guarda el timestamp del último correo revisado en una pestaña oculta del
 * Sheet de cashflow (no en un archivo local): Railway no conserva el
 * filesystem entre redeploys, así que un archivo local hacía que cada
 * redeploy reiniciara la ventana de revisión a las últimas 24h y repitiera
 * correos ya procesados.
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

export async function obtenerUltimoCheck(): Promise<number> {
  try {
    await ensureTab();
    const sheetId = assertSheetId();
    const sheets = getClient();

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A1`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    const valor = resp.data.values?.[0]?.[0];
    if (typeof valor === "number" && valor > 0) return valor;
  } catch (error) {
    console.error("[gmail/lastCheckStore] Error leyendo último check, usando ventana inicial:", error);
  }

  return Math.floor(Date.now() / 1000) - VENTANA_INICIAL_HORAS * 3600;
}

export async function guardarUltimoCheck(timestampUnixSeconds: number): Promise<void> {
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
