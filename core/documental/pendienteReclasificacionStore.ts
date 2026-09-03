import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_pendientes_reclasificacion_documento";
// 24h — mismo criterio que gastoPendienteDatosStore.ts y el resto de los "pendiente_*".
const TTL_MS = 24 * 60 * 60 * 1000;

const HEADERS = [
  "id",
  "chatId",
  "rutaLocal",
  "nombreArchivoOriginal",
  "mimeType",
  "tipoDocumentoOriginal",
  "correoOrigenJSON",
  "creadoEn",
];

/**
 * Bug real encontrado al verificar el sistema: "✏️ Elegir otra carpeta"
 * consumía (borraba) la propuesta de clasificación y preguntaba la empresa/
 * carpeta correctas por texto libre — pero esa pregunta no quedaba guardada
 * en ningún lado, así que la respuesta de Carlos no tenía forma de retomar
 * el archivado real (el archivo YA no tenía ninguna propuesta viva
 * asociada). El botón, en la práctica, no completaba nada. Este store
 * guarda lo necesario (ruta local, nombre, mimeType, contexto del correo)
 * para que reclasificarDocumentoPendiente.ts (tool) pueda terminar el
 * archivado real con la empresa/carpeta que el usuario acaba de confirmar —
 * mismo patrón que gastoPendienteDatosStore.ts / contactoResolucionStore.ts.
 */
export interface PendienteReclasificacion {
  id: string;
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  tipoDocumentoOriginal: string;
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; deColaCorreo?: boolean; /** Gmail interno (correo.id) + attachmentId del adjunto real — permite volver a descargarlo de Gmail si la copia local en tmp/uploads se pierde (ej. un redeploy de Railway entre que se descarga y que se usa). */ mensajeIdGmail?: string; attachmentIdGmail?: string };
  creadoEn: number;
}

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
    throw new Error("No se pudo crear la pestaña de pendientes de reclasificación.");
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

function rowToPendiente(row: unknown[]): PendienteReclasificacion | null {
  if (!row[0]) return null;

  let correoOrigen: PendienteReclasificacion["correoOrigen"];
  try {
    correoOrigen = row[6] ? JSON.parse(String(row[6])) : undefined;
  } catch {
    correoOrigen = undefined;
  }

  return {
    id: String(row[0]),
    chatId: Number(row[1]) || 0,
    rutaLocal: row[2] ? String(row[2]) : "",
    nombreArchivoOriginal: row[3] ? String(row[3]) : "",
    mimeType: row[4] ? String(row[4]) : undefined,
    tipoDocumentoOriginal: row[5] ? String(row[5]) : "",
    correoOrigen,
    creadoEn: Number(row[7]) || 0,
  };
}

function pendienteToRow(p: PendienteReclasificacion): (string | number)[] {
  return [
    p.id,
    p.chatId,
    p.rutaLocal,
    p.nombreArchivoOriginal,
    p.mimeType ?? "",
    p.tipoDocumentoOriginal,
    p.correoOrigen ? JSON.stringify(p.correoOrigen) : "",
    p.creadoEn,
  ];
}

interface FilaConIndice {
  rowIndex: number;
  pendiente: PendienteReclasificacion;
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
        { deleteDimension: { range: { sheetId: gridId, dimension: "ROWS", startIndex: rowIndex1Based - 1, endIndex: rowIndex1Based } } },
      ],
    },
  });
}

async function purgarVencidas(): Promise<void> {
  const todas = await leerTodas();
  const ahora = Date.now();
  const vencidas = todas.filter(({ pendiente }) => ahora - pendiente.creadoEn > TTL_MS);
  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) await eliminarFila(rowIndex);
}

export async function guardarPendienteReclasificacion(
  datos: Omit<PendienteReclasificacion, "id" | "creadoEn">
): Promise<PendienteReclasificacion> {
  await purgarVencidas();
  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const pendiente: PendienteReclasificacion = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:H`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [pendienteToRow(pendiente)] },
  });

  return pendiente;
}

/** Busca por chatId — para cuando el usuario responde en texto libre con la empresa/carpeta correctas. Si hay varias, consume la más reciente. */
export async function consumirPendienteReclasificacionPorChat(chatId: number): Promise<PendienteReclasificacion | undefined> {
  const todas = await leerTodas();
  const delChat = todas.filter(({ pendiente }) => pendiente.chatId === chatId);
  if (delChat.length === 0) return undefined;

  const masReciente = delChat.reduce((a, b) => (a.pendiente.creadoEn >= b.pendiente.creadoEn ? a : b));
  await eliminarFila(masReciente.rowIndex);
  return masReciente.pendiente;
}

/** Solo lectura (no consume) — para que buildSystemPromptDinamico avise de la pregunta pendiente. */
export async function obtenerPendienteReclasificacionPorChat(chatId: number): Promise<PendienteReclasificacion | undefined> {
  const todas = await leerTodas();
  const delChat = todas.filter(({ pendiente }) => pendiente.chatId === chatId);
  if (delChat.length === 0) return undefined;

  return delChat.reduce((a, b) => (a.pendiente.creadoEn >= b.pendiente.creadoEn ? a : b)).pendiente;
}
