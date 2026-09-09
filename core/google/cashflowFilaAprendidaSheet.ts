import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "./serviceAccount";
import { conMutex } from "../utils/asyncMutex";
import type { BloqueEscritura } from "./cashflowWrite";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_filas_cashflow_aprendidas";
const HEADERS = ["clave", "bloque", "clienteOConcepto", "semana", "fila", "actualizadoEn"];
const MAX_INTENTOS_ESCRITURA = 3;

/**
 * Pedido explícito de Carlos ("que la práctica y los días te vayan dando la
 * experiencia... para que cada día seas más inteligente y rápido"): mismo
 * principio que los otros 5 mecanismos de memoria, aplicado a la búsqueda de
 * filas del cashflow (buscarFilaCashflowParaEditar, core/google/cashflowWrite.ts)
 * — hoy cada búsqueda vuelve a escanear el bloque entero desde cero. Cada vez
 * que una edición se confirma con éxito (ver edicionValorCashflowCallbackHandler.ts),
 * se guarda a qué fila real correspondió ese bloque+concepto+semana. La
 * próxima búsqueda con la MISMA clave prueba primero la fila recordada — pero
 * SIEMPRE revalida que esa fila siga teniendo el nombre/semana/valor
 * esperados antes de confiar en ella (nunca a ciegas: si Carlos insertó o
 * borró filas a mano en el Sheet — algo que hace directamente — la fila
 * recordada puede haberse desplazado). Si no coincide, se auto-corrige
 * cayendo al escaneo completo de siempre, sin ningún error visible — pura
 * ganancia de velocidad cuando la memoria sigue siendo válida, cero riesgo
 * cuando no lo es.
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

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function clave(bloque: string, clienteOConcepto: string, semana: string): string {
  return `${bloque}|${normalizar(clienteOConcepto)}|${normalizar(semana)}`;
}

interface FilaCache {
  rowIndex: number;
  clave: string;
  fila: number;
}

async function leerFilas(): Promise<FilaCache[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:F10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaCache[] = [];
  rows.forEach((row, i) => {
    if (!row[0]) return;
    result.push({ rowIndex: i + 2, clave: String(row[0]), fila: Number(row[4]) || 0 });
  });
  return result;
}

/** Fila recordada para este bloque+concepto+semana, o undefined si nunca se confirmó una edición ahí. Nunca se usa a ciegas — quien llama debe revalidar el contenido de esa fila antes de confiar en ella. */
export async function obtenerFilaAprendida(bloque: BloqueEscritura, clienteOConcepto: string, semana: string): Promise<number | undefined> {
  const objetivo = clave(bloque, clienteOConcepto, semana);
  const filas = await leerFilas();
  const match = filas.find((f) => f.clave === objetivo);
  return match && match.fila > 0 ? match.fila : undefined;
}

/** Registra (o refuerza) a qué fila real corresponde este bloque+concepto+semana, tras una edición confirmada con éxito. */
export async function registrarFilaAprendida(bloque: BloqueEscritura, clienteOConcepto: string, semana: string, fila: number): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();
  const objetivo = clave(bloque, clienteOConcepto, semana);
  const filaValores = [objetivo, bloque, clienteOConcepto, semana, fila, new Date().toISOString()];

  await conMutex(`cashflowFilaAprendida:${TAB_NAME}`, async () => {
    const filas = await leerFilas();
    const match = filas.find((f) => f.clave === objetivo);

    if (match) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${match.rowIndex}:F${match.rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [filaValores] },
      });
      return;
    }

    for (let intento = 0; intento < MAX_INTENTOS_ESCRITURA; intento++) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A:F`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const filaLibre = (resp.data.values ?? []).length + 1;

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${filaLibre}:F${filaLibre}`,
        valueInputOption: "RAW",
        requestBody: { values: [filaValores] },
      });

      const verificacion = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${filaLibre}:F${filaLibre}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const filaEscrita = verificacion.data.values?.[0] ?? [];
      const coincide = filaValores.every((v, i) => String(filaEscrita[i] ?? "") === String(v));
      if (coincide) return;

      console.error(
        `[cashflowFilaAprendidaSheet] Colisión al escribir en "${TAB_NAME}", fila ${filaLibre} — reintento ${intento + 1}/${MAX_INTENTOS_ESCRITURA}.`
      );
    }
    // No crítico — perder esta caché no debe tumbar la edición real que ya tuvo éxito.
    console.error(`[cashflowFilaAprendidaSheet] No se pudo registrar la fila aprendida tras ${MAX_INTENTOS_ESCRITURA} intentos.`);
  });
}

/** Todas las filas aprendidas — para el reporte de aprendizaje (ver core/tools/reporteAprendizaje.ts). */
export async function obtenerTodasLasFilasAprendidas(): Promise<FilaCache[]> {
  return leerFilas();
}
