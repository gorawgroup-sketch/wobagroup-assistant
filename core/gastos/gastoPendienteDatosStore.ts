import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import type { DatosFactura } from "../documental/extractInvoiceData";

/**
 * Bug real encontrado en vivo: procesarGastoEntrante tiene dos ramas que NO
 * mandan una propuesta con botones (empresa sin identificar, o moneda
 * extranjera sin monto equivalente) — solo hacen una pregunta en texto
 * plano y retornan. Pero devolvía `void` igual que la rama que SÍ manda la
 * propuesta, así que procesarDocumentoLocal/capturarCorreo.ts no podían
 * distinguir "ya te mandé la propuesta con botón" de "te hice una
 * pregunta" — Wobi le dijo a Carlos "ya te la mandé por Telegram" dos veces
 * seguidas para una factura de Panamá (MERA AEROPUERTO DE PANAMA SA, 17.95
 * USD) cuando en realidad solo había preguntado la moneda equivalente, sin
 * ningún botón. Además, la pregunta en sí no se persistía en ningún lado
 * (a diferencia de contactoResolucionStore.ts / classificationStore.ts),
 * así que la respuesta de Carlos en texto libre no podía retomar el
 * proceso — cada intento releía el documento desde cero y volvía a
 * preguntar lo mismo. Este store, junto con reintentarGastoPendiente.ts,
 * cierra ambos huecos: guarda todo lo necesario para retomar sin releer el
 * documento, y buildSystemPromptDinamico avisa cuando hay una pregunta de
 * este tipo sin responder.
 */
export interface GastoPendienteDatos {
  id: string;
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  datos: DatosFactura;
  motivo: "empresa" | "moneda";
  creadoEn: number;
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_gastos_pendientes_datos";
// 24h — pedido explícito de Carlos (mismo criterio en todos los
// "pendiente_*", ver pendienteCapturaEmpresaStore.ts), igual que contactoResolucionStore.ts.
const TTL_MS = 24 * 60 * 60 * 1000;

const HEADERS = ["id", "chatId", "rutaLocal", "nombreArchivoOriginal", "mimeType", "datosJSON", "motivo", "creadoEn"];

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

let writeClient: sheets_v4.Sheets | null = null;
let tabGridId: number | null = null;

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

async function ensureTab(): Promise<number> {
  if (tabGridId !== null) return tabGridId;

  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME);

  if (existing?.properties?.sheetId != null) {
    tabGridId = existing.properties.sheetId;
    return tabGridId;
  }

  const addResp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
  });

  const newSheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId == null) {
    throw new Error("No se pudo crear la pestaña de gastos pendientes de datos.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:H1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToPendiente(row: unknown[]): GastoPendienteDatos | null {
  if (!row[0]) return null;

  let datos: DatosFactura;
  try {
    datos = row[5] ? JSON.parse(String(row[5])) : null;
  } catch {
    return null; // fila corrupta — mejor ignorarla que tumbar el resto
  }
  if (!datos) return null;

  const motivo = row[6] === "empresa" || row[6] === "moneda" ? row[6] : "moneda";

  return {
    id: String(row[0]),
    chatId: Number(row[1]) || 0,
    rutaLocal: row[2] ? String(row[2]) : "",
    nombreArchivoOriginal: row[3] ? String(row[3]) : "",
    mimeType: row[4] ? String(row[4]) : undefined,
    datos,
    motivo,
    creadoEn: Number(row[7]) || 0,
  };
}

function pendienteToRow(p: GastoPendienteDatos): (string | number)[] {
  return [
    p.id,
    p.chatId,
    p.rutaLocal,
    p.nombreArchivoOriginal,
    p.mimeType ?? "",
    JSON.stringify(p.datos),
    p.motivo,
    p.creadoEn,
  ];
}

interface FilaConIndice {
  rowIndex: number;
  pendiente: GastoPendienteDatos;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:H10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    const pendiente = rowToPendiente(row);
    if (pendiente) result.push({ rowIndex: i + 2, pendiente });
  });
  return result;
}

async function eliminarFila(rowIndex1Based: number): Promise<void> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const gridId = await ensureTab();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId: gridId, dimension: "ROWS", startIndex: rowIndex1Based - 1, endIndex: rowIndex1Based },
          },
        },
      ],
    },
  });
}

async function purgarVencidas(): Promise<void> {
  const todas = await leerTodas();
  const ahora = Date.now();
  const vencidas = todas.filter(({ pendiente }) => ahora - pendiente.creadoEn > TTL_MS);

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

export async function guardarGastoPendienteDatos(
  datos: Omit<GastoPendienteDatos, "id" | "creadoEn">
): Promise<GastoPendienteDatos> {
  await purgarVencidas();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const pendiente: GastoPendienteDatos = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:H`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [pendienteToRow(pendiente)] },
  });

  return pendiente;
}

/**
 * Busca por chatId — para cuando el usuario responde en texto libre a la
 * pregunta pendiente en vez de reenviar el documento. Si hay varias del
 * mismo chat, consume la más reciente.
 */
export async function consumirGastoPendienteDatosPorChat(chatId: number): Promise<GastoPendienteDatos | undefined> {
  const todas = await leerTodas();
  const delChat = todas.filter(({ pendiente }) => pendiente.chatId === chatId);
  if (delChat.length === 0) return undefined;

  const masReciente = delChat.reduce((a, b) => (a.pendiente.creadoEn >= b.pendiente.creadoEn ? a : b));
  await eliminarFila(masReciente.rowIndex);
  return masReciente.pendiente;
}

/** Solo lectura (no consume) — para que buildSystemPromptDinamico avise de la pregunta pendiente. */
export async function obtenerGastoPendienteDatosPorChat(chatId: number): Promise<GastoPendienteDatos | undefined> {
  const todas = await leerTodas();
  const delChat = todas.filter(({ pendiente }) => pendiente.chatId === chatId);
  if (delChat.length === 0) return undefined;

  return delChat.reduce((a, b) => (a.pendiente.creadoEn >= b.pendiente.creadoEn ? a : b)).pendiente;
}
