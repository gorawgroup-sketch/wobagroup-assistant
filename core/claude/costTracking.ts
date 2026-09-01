import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_costos_ia";
const HEADERS = ["fecha", "chatId", "modelo", "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "costoUSD"];

// Tarifas oficiales por modelo (USD por token) — el sistema ahora enruta
// entre varios modelos (core/claude/client.ts), así que el costo ya no se
// puede calcular con una sola tarifa fija. Si se agrega o cambia un modelo,
// hay que actualizar esta tabla — si no, /costos_ia calcula con una tarifa
// que no corresponde al modelo real que respondió.
const PRECIOS_POR_MODELO: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2.0 / 1_000_000, output: 10.0 / 1_000_000 },
  "claude-haiku-4-5": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  // Usado por extraerDatosFactura y classifyFile — verificado en vivo contra
  // la tabla oficial de precios de Anthropic (bug real encontrado: estas
  // llamadas usaban este modelo pero ni siquiera estaban en la tabla, así
  // que ni se registraban — ver también registrarUsoIA en esos archivos).
  "claude-sonnet-4-6": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};

// Tarifa de respaldo si algún día se usa un modelo que no está en la tabla
// de arriba — mejor sobreestimar (tarifa más cara conocida) que subestimar
// el costo real y no darse cuenta de un aumento de gasto.
const PRECIOS_POR_DEFECTO = PRECIOS_POR_MODELO["claude-sonnet-5"];

function obtenerPrecios(modelo: string): { input: number; output: number } {
  return PRECIOS_POR_MODELO[modelo] ?? PRECIOS_POR_DEFECTO;
}

// Bug real que esto evita repetir (mismo patrón que ya pasó con
// claude-sonnet-4-6, ver comentario arriba): la tool de búsqueda web
// (core/claude/client.ts, WEB_SEARCH_TOOL) se factura APARTE de los tokens
// normales — $10 USD cada 1.000 búsquedas, verificado en vivo contra la
// documentación oficial 2026-09-01 — y viene en un campo de `usage`
// separado (server_tool_use.web_search_requests) que calcularCostoUSD no
// leía. Sin esto, cada búsqueda real habría quedado invisible en
// /costos_ia — el mismo error de "esta llamada real no se registraba".
const PRECIO_POR_BUSQUEDA_WEB = 10 / 1000;

export interface UsoAnthropic {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
}

export function calcularCostoUSD(usage: UsoAnthropic, modelo: string): number {
  const { input: precioInput, output: precioOutput } = obtenerPrecios(modelo);
  // La escritura de caché cuesta 25% más que el input normal; la lectura de
  // caché cuesta 10% del input normal — misma proporción para todos los
  // modelos de Claude, solo cambia la tarifa base de la que parten.
  const precioCacheWrite = precioInput * 1.25;
  const precioCacheRead = precioInput * 0.1;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const busquedasWeb = usage.server_tool_use?.web_search_requests ?? 0;

  return (
    inputTokens * precioInput +
    outputTokens * precioOutput +
    cacheCreation * precioCacheWrite +
    cacheRead * precioCacheRead +
    busquedasWeb * PRECIO_POR_BUSQUEDA_WEB
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
export async function registrarUsoIA(chatId: number | undefined, modelo: string, usage: UsoAnthropic): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const costoUSD = calcularCostoUSD(usage, modelo);

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
          modelo,
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
