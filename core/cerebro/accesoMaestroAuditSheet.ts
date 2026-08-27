import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_cerebro_accesos_maestro_otorgados";
const HEADERS = ["nombre", "otorgadoEn"];

/**
 * Registro PERMANENTE (a diferencia de accesoSolicitudSheet.ts, que purga
 * cada fila resuelta a los 5 minutos por seguridad — la key maestra en
 * texto plano no debe quedar sentada ahí) de a quién se le entregó la key
 * maestra alguna vez y cuándo. NUNCA guarda la key en sí, solo el nombre y
 * la fecha — así queda una auditoría legible sin repetir el riesgo que
 * accesoSolicitudSheet.ts evita a propósito. No hay forma de revocar a una
 * persona individualmente de aquí (la key es un secreto compartido, no hay
 * una fila por titular que se pueda invalidar sola) — solo sirve para
 * saber quién la tiene, no para quitársela.
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

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:B1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

export interface AccesoMaestroOtorgado {
  nombre: string;
  otorgadoEn: string;
}

/** Deja constancia de que se le entregó la key maestra a `nombre` — no crítico, nunca debe tumbar el flujo real de entrega. */
export async function registrarAccesoMaestroOtorgado(nombre: string): Promise<void> {
  try {
    await ensureTab();
    const sheetId = assertSheetId();
    const sheets = getClient();

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A:B`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[nombre, new Date().toISOString()]] },
    });
  } catch (error) {
    console.error("[accesoMaestroAuditSheet] Error registrando entrega de key maestra (no crítico):", error);
  }
}

export async function listarAccesosMaestroOtorgados(): Promise<AccesoMaestroOtorgado[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:B10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const filas = resp.data.values ?? [];
  return filas
    .filter((f) => f[0])
    .map((f) => ({ nombre: String(f[0]), otorgadoEn: f[1] ? String(f[1]) : "" }))
    .reverse();
}
