import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_costos_ia";
const HEADERS = ["fecha", "chatId", "modelo", "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "costoUSD"];

// Tarifas oficiales de claude-sonnet-4-6 (el único modelo que usa el
// sistema hoy — core/claude/client.ts MODEL). Si el modelo cambia, hay que
// actualizar estas constantes.
const MODELO = "claude-sonnet-4-6";
const PRECIO_INPUT_POR_TOKEN = 3.0 / 1_000_000;
const PRECIO_OUTPUT_POR_TOKEN = 15.0 / 1_000_000;
// El sistema hoy no usa prompt caching (no se setea cache_control en
// ninguna llamada), así que estos campos siempre serán 0 en la práctica —
// se calculan de todas formas por si se activa caching más adelante.
const PRECIO_CACHE_WRITE_POR_TOKEN = PRECIO_INPUT_POR_TOKEN * 1.25;
const PRECIO_CACHE_READ_POR_TOKEN = PRECIO_INPUT_POR_TOKEN * 0.1;

export interface UsoAnthropic {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function calcularCostoUSD(usage: UsoAnthropic): number {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  return (
    inputTokens * PRECIO_INPUT_POR_TOKEN +
    outputTokens * PRECIO_OUTPUT_POR_TOKEN +
    cacheCreation * PRECIO_CACHE_WRITE_POR_TOKEN +
    cacheRead * PRECIO_CACHE_READ_POR_TOKEN
  );
}

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
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:H1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

/**
 * Registra el costo de UNA llamada a la API de Claude (cada iteración del
 * loop de tool-use en askClaude, no solo la respuesta final — cada una se
 * factura por separado). Se llama en "fire and forget" desde askClaude para
 * no añadir la latencia de escribir en Sheets a la respuesta del usuario.
 */
export async function registrarUsoIA(chatId: number | undefined, usage: UsoAnthropic): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const costoUSD = calcularCostoUSD(usage);

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:H`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          new Date().toISOString(),
          chatId ?? "",
          MODELO,
          usage.input_tokens ?? 0,
          usage.output_tokens ?? 0,
          usage.cache_creation_input_tokens ?? 0,
          usage.cache_read_input_tokens ?? 0,
          costoUSD,
        ],
      ],
    },
  });
}

export interface ResumenCostos {
  llamadas: number;
  inputTokens: number;
  outputTokens: number;
  costoUSD: number;
}

interface FilaUso {
  fecha: Date;
  costoUSD: number;
  inputTokens: number;
  outputTokens: number;
}

async function leerFilas(): Promise<FilaUso[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:H200000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      fecha: new Date(String(row[0])),
      inputTokens: Number(row[3]) || 0,
      outputTokens: Number(row[4]) || 0,
      costoUSD: Number(row[7]) || 0,
    }));
}

/** Resume el costo entre `desde` (inclusive) y `hasta` (exclusive). */
export async function obtenerResumenCostos(desde: Date, hasta: Date): Promise<ResumenCostos> {
  const filas = await leerFilas();
  const enRango = filas.filter((f) => f.fecha >= desde && f.fecha < hasta);

  return enRango.reduce(
    (acc, f) => ({
      llamadas: acc.llamadas + 1,
      inputTokens: acc.inputTokens + f.inputTokens,
      outputTokens: acc.outputTokens + f.outputTokens,
      costoUSD: acc.costoUSD + f.costoUSD,
    }),
    { llamadas: 0, inputTokens: 0, outputTokens: 0, costoUSD: 0 }
  );
}

/** Costo total por día, para los últimos `dias` días completos (excluye hoy). */
export async function obtenerCostoPorDia(dias: number, referencia: Date = new Date()): Promise<number[]> {
  const filas = await leerFilas();
  const hoyNorm = new Date(referencia.getFullYear(), referencia.getMonth(), referencia.getDate());

  const costos: number[] = [];
  for (let i = dias; i >= 1; i--) {
    const inicio = new Date(hoyNorm);
    inicio.setDate(inicio.getDate() - i);
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 1);

    const total = filas
      .filter((f) => f.fecha >= inicio && f.fecha < fin)
      .reduce((acc, f) => acc + f.costoUSD, 0);
    costos.push(total);
  }
  return costos;
}
