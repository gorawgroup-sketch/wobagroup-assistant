import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../../google/serviceAccount";
import type { EventoBitacoraPedido } from "./router";

/**
 * Bitácora PERMANENTE de pedidos desde el front: quién (persona de Telegram, no la clave), desde qué dispositivo (huella corta), qué
 * pedido (id + referencia visible en Telegram), cuándo y la huella del texto. Nunca guarda el texto ni claves: el texto vive en el
 * historial del chat de esa persona (a continuación del eco «Pedido desde el front (ref. …)»). Solo añade filas, nunca las edita.
 */
const TAB_NAME = "_cerebro_pedidos_front";
const HEADERS = ["cuando", "evento", "pedidoId", "ref", "chatId", "nombre", "rol", "dispositivo", "textoHash", "longitud", "detalle"];

function assertSheetId(): string {
  const id = process.env.CASHFLOW_SHEET_ID;
  if (!id) throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  return id;
}

let writeClient: sheets_v4.Sheets | null = null;
let tabAsegurada = false;

function getClient(): sheets_v4.Sheets {
  if (writeClient) return writeClient;
  const credentials = loadServiceAccountCredentials();
  const auth = new google.auth.JWT({ email: credentials.client_email, key: credentials.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  writeClient = google.sheets({ version: "v4", auth });
  return writeClient;
}

async function ensureTab(): Promise<void> {
  if (tabAsegurada) return;
  const sheetId = assertSheetId();
  const sheets = getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existe = meta.data.sheets?.some((s) => s.properties?.title === TAB_NAME);
  if (!existe) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `${TAB_NAME}!A1:K1`, valueInputOption: "RAW", requestBody: { values: [HEADERS] } });
  }
  tabAsegurada = true;
}

/** Lanza si no se pudo escribir: quien llama decide (el router lo deja registrado en el log sin tumbar el pedido). */
export async function registrarBitacoraPedido(e: EventoBitacoraPedido): Promise<void> {
  await ensureTab();
  await getClient().spreadsheets.values.append({
    spreadsheetId: assertSheetId(), range: `${TAB_NAME}!A:K`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[new Date().toISOString(), e.evento, e.pedidoId, e.ref, e.chatId, e.nombre, e.rol ?? "", e.dispositivo, e.textoHash, e.longitud, e.detalle ?? ""]] },
  });
}
