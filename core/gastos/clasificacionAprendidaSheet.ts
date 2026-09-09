import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { conMutex } from "../utils/asyncMutex";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_clasificaciones_aprendidas";
const HEADERS = ["proveedor", "empresa", "concepto", "vecesConfirmado", "actualizadoEn"];

/**
 * "Memoria" de clasificación de gastos: qué empresa/concepto le corresponde
 * a cada proveedor, aprendida de lo que el equipo confirma o corrige (ver
 * gastoCallbackHandler.ts). extractInvoiceData.ts la consulta antes de
 * proponer una clasificación, así que un proveedor que ya se vio antes se
 * clasifica cada vez con más certeza — sin reentrenar nada, solo leyendo
 * esta tabla como contexto adicional (mismo principio que
 * _correcciones para el conocimiento general).
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
    range: `${TAB_NAME}!A1:E1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

export interface FilaAprendida {
  rowIndex: number;
  proveedor: string;
  empresa: string;
  concepto: string;
  vecesConfirmado: number;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .trim();
}

async function leerFilas(): Promise<FilaAprendida[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:E10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaAprendida[] = [];
  rows.forEach((row, i) => {
    if (!row[0]) return;
    result.push({
      rowIndex: i + 2,
      proveedor: String(row[0]),
      empresa: row[1] ? String(row[1]) : "",
      concepto: row[2] ? String(row[2]) : "",
      vecesConfirmado: Number(row[3]) || 0,
    });
  });
  return result;
}

/** Devuelve el contexto de clasificaciones aprendidas, formateado para incluir en el prompt del extractor. */
export async function obtenerClasificacionesAprendidas(): Promise<string | null> {
  const filas = await leerFilas();
  if (filas.length === 0) return null;

  return filas
    .map((f) => `- ${f.proveedor} → empresa: ${f.empresa}${f.concepto ? `, concepto habitual: ${f.concepto}` : ""}`)
    .join("\n");
}

/**
 * Registra (o refuerza) la asociación proveedor → empresa/concepto. Se llama
 * cuando el usuario confirma una clasificación propuesta (refuerza) o la
 * corrige (sobreescribe con el dato correcto).
 */
const MAX_INTENTOS_ESCRITURA = 3;

/**
 * Hallazgo real de auditoría (misma noche, mismo bug ya cerrado en varios
 * otros archivos): el camino de clasificación NUEVA usaba values.append, y
 * "leer, decidir si existe, escribir" no tenía lock — mismo fix ya
 * establecido: todo bajo conMutex, fila libre calculada a mano + rango
 * explícito para el caso nuevo, con verificación y reintento.
 */
export async function registrarClasificacionAprendida(proveedor: string, empresa: string, concepto: string): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();
  const objetivo = normalizar(proveedor);

  await conMutex(`clasificacionAprendida:${TAB_NAME}`, async () => {
    const filas = await leerFilas();
    const match = filas.find((f) => normalizar(f.proveedor) === objetivo);

    if (match) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!B${match.rowIndex}:E${match.rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [[empresa, concepto, match.vecesConfirmado + 1, new Date().toISOString()]] },
      });
      return;
    }

    const filaNueva = [proveedor, empresa, concepto, 1, new Date().toISOString()];
    for (let intento = 0; intento < MAX_INTENTOS_ESCRITURA; intento++) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A:E`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const filaLibre = (resp.data.values ?? []).length + 1;

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${filaLibre}:E${filaLibre}`,
        valueInputOption: "RAW",
        requestBody: { values: [filaNueva] },
      });

      const verificacion = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${filaLibre}:E${filaLibre}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const filaEscrita = verificacion.data.values?.[0] ?? [];
      const coincide = filaNueva.every((v, i) => String(filaEscrita[i] ?? "") === String(v));
      if (coincide) return;

      console.error(
        `[clasificacionAprendidaSheet] Colisión al escribir en "${TAB_NAME}", fila ${filaLibre} — reintento ${intento + 1}/${MAX_INTENTOS_ESCRITURA}.`
      );
    }
    throw new Error(`No se pudo registrar la clasificación aprendida tras ${MAX_INTENTOS_ESCRITURA} intentos por colisiones repetidas.`);
  });
}

/** Todas las clasificaciones aprendidas — para el reporte de aprendizaje (ver core/tools/reporteAprendizaje.ts). */
export async function obtenerTodasLasClasificaciones(): Promise<FilaAprendida[]> {
  return leerFilas();
}
