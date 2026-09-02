import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "./serviceAccount";

/**
 * Causa raíz real, encontrada en vivo (2026-09-02): varios stores de
 * "pendientes"/"propuestas" (botones que se crean ahora y se consumen más
 * tarde — a veces horas después) vivían en un archivo JSON local
 * (data/*.json). Eso funciona DENTRO de una sola ejecución, pero se rompe
 * en cuanto la creación y el consumo pasan por procesos distintos — que es
 * exactamente lo que ocurre en producción real: `railway run` para probar
 * no comparte disco con el servidor desplegado, Y CUALQUIER redeploy real
 * (frecuentes en desarrollo activo) borra el filesystem de Railway por
 * completo. Caso real que lo confirmó: una propuesta de anotación de
 * cashflow creada por un script de prueba nunca la encontró el botón
 * "✏️ Dar instrucciones" pulsado después, porque cada uno corrió en un
 * proceso con su propio disco efímero. Mismo patrón raíz ya resuelto antes
 * en este proyecto para conversationStore.ts, gastoPendienteDatosStore.ts,
 * etc. — ahora centralizado acá para no repetir el mismo error de nuevo en
 * el próximo store que alguien agregue.
 *
 * Este módulo da el mínimo común de Sheets-como-almacén-clave-valor que
 * necesitan esos stores (una fila por registro, una pestaña oculta por
 * store) sin que cada uno reimplemente ensureTab/leerFilas/etc. Cada store
 * sigue definiendo su propia forma de datos (columnas, TTL, semántica de
 * "consumir") — esto solo maneja el Sheets de abajo.
 */

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;

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

function colLetter(numCols: number): string {
  // Suficiente para el rango de columnas que usan estos stores (todos <26 columnas, A-Z).
  return String.fromCharCode("A".charCodeAt(0) + numCols - 1);
}

const tabsAseguradas = new Map<string, number>(); // tabName -> gridId

/** Crea la pestaña (oculta) si no existe, con estos headers en la fila 1. Idempotente y cacheado en memoria. */
export async function ensureTab(tabName: string, headers: string[]): Promise<number> {
  const cacheado = tabsAseguradas.get(tabName);
  if (cacheado !== undefined) return cacheado;

  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === tabName);
  if (existing?.properties?.sheetId != null) {
    tabsAseguradas.set(tabName, existing.properties.sheetId);
    return existing.properties.sheetId;
  }

  const addResp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName, hidden: true } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!A1:${colLetter(headers.length)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });

  const gridId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  tabsAseguradas.set(tabName, gridId);
  return gridId;
}

export interface FilaCruda {
  rowIndex: number; // 1-based, incluye el offset de la fila de headers
  valores: string[];
}

/** Lee todas las filas con datos (fila 1 es headers, se excluye) — valores siempre como string, "" si la celda está vacía. */
export async function leerFilas(tabName: string, numCols: number, headers: string[]): Promise<FilaCruda[]> {
  await ensureTab(tabName, headers);
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!A2:${colLetter(numCols)}10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  return rows
    .filter((row) => row[0] !== undefined && row[0] !== "")
    .map((row, i) => ({
      rowIndex: i + 2,
      valores: Array.from({ length: numCols }, (_, c) => (row[c] == null ? "" : String(row[c]))),
    }));
}

/** Agrega una fila nueva al final de la pestaña. */
export async function agregarFila(tabName: string, numCols: number, headers: string[], valores: (string | number)[]): Promise<void> {
  await ensureTab(tabName, headers);
  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tabName}!A:${colLetter(numCols)}`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [valores] },
  });
}

/** Sobrescribe una fila existente (por su rowIndex, ver leerFilas). */
export async function actualizarFila(tabName: string, rowIndex: number, numCols: number, valores: (string | number)[]): Promise<void> {
  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!A${rowIndex}:${colLetter(numCols)}${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [valores] },
  });
}

/** Borra una fila (por su rowIndex). Se usa al "consumir" un pendiente. */
export async function eliminarFila(tabName: string, rowIndex: number, headers: string[]): Promise<void> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const gridId = await ensureTab(tabName, headers);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        { deleteDimension: { range: { sheetId: gridId, dimension: "ROWS", startIndex: rowIndex - 1, endIndex: rowIndex } } },
      ],
    },
  });
}
