import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "./serviceAccount";

let sheetsClient: sheets_v4.Sheets | null = null;

/**
 * Devuelve un cliente autenticado de la API de Google Sheets (solo lectura),
 * reutilizado entre llamadas.
 */
export function getSheetsClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const credentials = loadServiceAccountCredentials();

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/** Chequeo mínimo de conexión (metadata, sin leer celdas) para el panel de conexiones. */
export async function verificarConexionSheets(): Promise<{ ok: boolean; detalle?: string }> {
  const sheetId = process.env.CASHFLOW_SHEET_ID;
  if (!sheetId) return { ok: false, detalle: "Falta la variable de entorno CASHFLOW_SHEET_ID." };

  try {
    await getSheetsClient().spreadsheets.get({ spreadsheetId: sheetId, fields: "spreadsheetId" });
    return { ok: true };
  } catch (error) {
    return { ok: false, detalle: error instanceof Error ? error.message : String(error) };
  }
}
