import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { textosParecidos } from "../utils/textoParecido";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_duplicados_confirmados";
const HEADERS = ["proveedor", "empresa", "montoHolded", "montoCashflow", "diferencia", "confirmadoEn"];

/**
 * "Memoria" de duplicados confirmados a mano: cuando el usuario confirma que
 * un movimiento de Holded con nombre parecido pero monto distinto al ya
 * registrado es en realidad EL MISMO pago (botón "🔁 Es duplicado" en
 * gastoCallbackHandler/telegram/callbackHandler.ts), queda guardado aquí —
 * y detectarNoRegistrados (revisarHoldedVsCashflow.ts) consulta este
 * historial para reconocer automáticamente el mismo patrón de variación en
 * futuros movimientos del mismo proveedor, sin volver a preguntar. Pedido
 * explícito: que el sistema "vaya aprendiendo y se vuelva más inteligente
 * cada día" con los casos reales que el usuario le va mostrando — mismo
 * principio que clasificacionAprendidaSheet.ts y proveedorAliasSheet.ts,
 * aplicado aquí a la variación de monto entre Holded y el cashflow.
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

export interface FilaDuplicado {
  proveedor: string;
  empresa: string;
  montoHolded: number;
  montoCashflow: number;
  diferencia: number;
}

async function leerFilas(): Promise<FilaDuplicado[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:F10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      proveedor: String(row[0]),
      empresa: row[1] ? String(row[1]) : "",
      montoHolded: Number(row[2]) || 0,
      montoCashflow: Number(row[3]) || 0,
      diferencia: Number(row[4]) || 0,
    }));
}

/** Registra un caso confirmado a mano: este proveedor, con esta diferencia de monto, es el mismo pago. */
export async function registrarDuplicadoConfirmado(
  proveedor: string,
  empresa: string,
  montoHolded: number,
  montoCashflow: number
): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const diferencia = Math.abs(montoHolded - montoCashflow);

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:F`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[proveedor, empresa, montoHolded, montoCashflow, diferencia, new Date().toISOString()]],
    },
  });
}

/**
 * Busca si ya hay algún duplicado confirmado para un proveedor parecido
 * (misma empresa) y devuelve la mayor diferencia de monto vista hasta
 * ahora — esa se usa como tolerancia aprendida para reconocer
 * automáticamente el mismo patrón la próxima vez, en vez de preguntar de
 * nuevo. undefined si nunca se ha confirmado un caso para este proveedor.
 */
export async function obtenerToleranciaAprendida(proveedor: string, empresa: string): Promise<number | undefined> {
  const filas = await leerFilas();
  const coincidencias = filas.filter((f) => f.empresa === empresa && textosParecidos(proveedor, f.proveedor));
  if (coincidencias.length === 0) return undefined;

  return Math.max(...coincidencias.map((f) => f.diferencia));
}

/**
 * Todos los duplicados confirmados, sin filtrar — pensado para que quien
 * revisa MUCHOS movimientos de una sola vez (detectarNoRegistrados) lea la
 * tabla una sola vez en vez de una consulta por movimiento.
 */
export async function obtenerTodosLosDuplicadosConfirmados(): Promise<FilaDuplicado[]> {
  return leerFilas();
}
