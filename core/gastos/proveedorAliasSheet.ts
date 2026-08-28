import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import type { Empresa } from "../holded/client";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_alias_proveedores_holded";
const HEADERS = ["nombreDetectado", "empresa", "contactId", "contactName", "vecesConfirmado", "actualizadoEn"];

/**
 * "Memoria" de qué contacto real de Holded corresponde a un nombre de
 * proveedor tal como lo lee la extracción de factura, para los casos en que
 * el match automático (buscarContactoHolded) no encontró nada y el usuario
 * confirmó manualmente una alternativa (ver gastoCallbackHandler.ts). La
 * próxima factura del mismo proveedor, con el mismo texto detectado, resuelve
 * directo sin volver a preguntar — igual principio que
 * clasificacionAprendidaSheet.ts pero para el contacto, no la clasificación.
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
    range: `${TAB_NAME}!A1:F1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

interface FilaAlias {
  rowIndex: number;
  nombreDetectado: string;
  empresa: string;
  contactId: string;
  contactName: string;
  vecesConfirmado: number;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function leerFilas(): Promise<FilaAlias[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:F10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaAlias[] = [];
  rows.forEach((row, i) => {
    if (!row[0]) return;
    result.push({
      rowIndex: i + 2,
      nombreDetectado: String(row[0]),
      empresa: row[1] ? String(row[1]) : "",
      contactId: row[2] ? String(row[2]) : "",
      contactName: row[3] ? String(row[3]) : "",
      vecesConfirmado: Number(row[4]) || 0,
    });
  });
  return result;
}

/** Busca un alias ya confirmado para este proveedor+empresa (match exacto tras normalizar). */
export async function buscarAliasProveedor(
  empresa: Empresa,
  nombreDetectado: string
): Promise<{ contactId: string; contactName: string } | undefined> {
  const filas = await leerFilas();
  const objetivo = normalizar(nombreDetectado);
  const match = filas.find((f) => f.empresa === empresa && normalizar(f.nombreDetectado) === objetivo);
  return match ? { contactId: match.contactId, contactName: match.contactName } : undefined;
}

/**
 * Registra (o refuerza) que este texto de proveedor corresponde a este
 * contacto real de Holded. Se llama cuando el usuario confirma manualmente
 * una alternativa tras un "no encontré el proveedor".
 */
export async function registrarAliasProveedor(
  empresa: Empresa,
  nombreDetectado: string,
  contactId: string,
  contactName: string
): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const filas = await leerFilas();
  const objetivo = normalizar(nombreDetectado);
  const match = filas.find((f) => f.empresa === empresa && normalizar(f.nombreDetectado) === objetivo);

  if (match) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!C${match.rowIndex}:F${match.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[contactId, contactName, match.vecesConfirmado + 1, new Date().toISOString()]] },
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:F`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[nombreDetectado, empresa, contactId, contactName, 1, new Date().toISOString()]] },
  });
}
