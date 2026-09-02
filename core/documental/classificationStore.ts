import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import type { ClasificacionDocumento } from "./classifyFile";

export interface PropuestaClasificacion {
  id: string;
  nombreArchivoOriginal: string;
  /** Ruta local donde quedó guardado el archivo (tmp/uploads/...). */
  rutaLocal: string;
  mimeType?: string;
  clasificacion: ClasificacionDocumento;
  chatId: number;
  messageId: number;
  creadoEn: number;
  /** Si el archivo vino de un correo, sus datos — para poder responderlo (con hilo real) después de archivar. */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string };
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_propuestas_documentos";
// Bug real encontrado en vivo: este store vivía en un archivo JSON local
// (data/propuestas_documentos.json) — a diferencia de TODOS los demás
// stores de propuestas pendientes del proyecto (gastos, conciliaciones,
// correcciones, historial de chat...), que ya se migraron a Sheets
// precisamente porque el filesystem de Railway se borra en cada redeploy.
// Este quedó sin migrar: cualquier propuesta de archivar un documento que
// estuviera pendiente al momento de un redeploy (algo frecuente en sesiones
// de desarrollo activas) se perdía en silencio, sin que el usuario ni el
// asistente se enteraran. Mismo patrón que gastoProposalSheet.ts.
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas, igual que antes

const HEADERS = [
  "id",
  "nombreArchivoOriginal",
  "rutaLocal",
  "mimeType",
  "clasificacionJSON",
  "chatId",
  "messageId",
  "creadoEn",
  "correoOrigenJSON",
];

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
    throw new Error("No se pudo crear la pestaña de propuestas de documentos.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:I1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToPropuesta(row: unknown[]): PropuestaClasificacion | null {
  if (!row[0]) return null;

  let clasificacion: ClasificacionDocumento;
  try {
    clasificacion = row[4] ? JSON.parse(String(row[4])) : null;
  } catch {
    clasificacion = null as unknown as ClasificacionDocumento;
  }
  if (!clasificacion) return null; // fila corrupta — mejor ignorarla que tumbar el resto

  let correoOrigen: PropuestaClasificacion["correoOrigen"];
  try {
    correoOrigen = row[8] ? JSON.parse(String(row[8])) : undefined;
  } catch {
    correoOrigen = undefined;
  }

  return {
    id: String(row[0]),
    nombreArchivoOriginal: row[1] ? String(row[1]) : "",
    rutaLocal: row[2] ? String(row[2]) : "",
    mimeType: row[3] ? String(row[3]) : undefined,
    clasificacion,
    chatId: Number(row[5]) || 0,
    messageId: Number(row[6]) || 0,
    creadoEn: Number(row[7]) || 0,
    correoOrigen,
  };
}

function propuestaToRow(p: PropuestaClasificacion): (string | number)[] {
  return [
    p.id,
    p.nombreArchivoOriginal,
    p.rutaLocal,
    p.mimeType ?? "",
    JSON.stringify(p.clasificacion),
    p.chatId,
    p.messageId,
    p.creadoEn,
    p.correoOrigen ? JSON.stringify(p.correoOrigen) : "",
  ];
}

interface FilaConIndice {
  rowIndex: number;
  propuesta: PropuestaClasificacion;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:I10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    const propuesta = rowToPropuesta(row);
    if (propuesta) result.push({ rowIndex: i + 2, propuesta });
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
  const vencidas = todas.filter(({ propuesta }) => ahora - propuesta.creadoEn > TTL_MS);

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

export async function crearPropuestaClasificacion(
  datos: Omit<PropuestaClasificacion, "id" | "creadoEn">
): Promise<PropuestaClasificacion> {
  await purgarVencidas();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const propuesta: PropuestaClasificacion = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:I`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [propuestaToRow(propuesta)] },
  });

  return propuesta;
}

/** Actualiza el message_id real de Telegram tras enviar el mensaje con botones. */
export async function actualizarMessageIdClasificacion(id: string, messageId: number): Promise<void> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!G${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[messageId]] },
  });
}

/**
 * Devuelve la propuesta y la elimina (aprobada o redirigida, ya no debe
 * quedar pendiente). También purga cualquier propuesta vencida.
 */
export async function consumirPropuestaClasificacion(id: string): Promise<PropuestaClasificacion | undefined> {
  await purgarVencidas();
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.propuesta;
}

/**
 * Igual que consumirPropuestaClasificacion, pero busca por chatId en vez de
 * por id — para cuando el usuario responde en texto libre a una propuesta
 * con botones en vez de presionarlos (ver confirmarArchivoPendiente.ts).
 * Si hay varias pendientes del mismo chat, consume la más reciente.
 */
export async function consumirPropuestaClasificacionPorChat(chatId: number): Promise<PropuestaClasificacion | undefined> {
  await purgarVencidas();
  const todas = await leerTodas();
  const delChat = todas.filter(({ propuesta }) => propuesta.chatId === chatId);
  if (delChat.length === 0) return undefined;

  const masReciente = delChat.reduce((a, b) => (a.propuesta.creadoEn >= b.propuesta.creadoEn ? a : b));
  await eliminarFila(masReciente.rowIndex);
  return masReciente.propuesta;
}

/**
 * Solo lectura (no consume) — para los botones "📚 Enseñar regla" / "⏰ Crear
 * alerta" (ver documentCallbackHandler.ts), que necesitan los datos de la
 * clasificación SIN quitarle la propuesta de archivo a la persona — "✅ Sí,
 * archivar aquí" / "✏️ Elegir otra carpeta" deben seguir funcionando después.
 */
export async function obtenerPropuestaClasificacion(id: string): Promise<PropuestaClasificacion | undefined> {
  const todas = await leerTodas();
  return todas.find(({ propuesta }) => propuesta.id === id)?.propuesta;
}

/**
 * Solo lectura (no consume) — para que el asistente conversacional sepa que
 * hay una propuesta de archivo esperando respuesta ANTES de decidir qué
 * hacer con el mensaje del usuario (ver buildSystemPromptDinamico en
 * core/claude/client.ts). Devuelve la más reciente si hay varias.
 */
export async function obtenerPropuestaClasificacionPendientePorChat(chatId: number): Promise<PropuestaClasificacion | undefined> {
  const todas = await leerTodas();
  const delChat = todas.filter(({ propuesta }) => propuesta.chatId === chatId);
  if (delChat.length === 0) return undefined;

  return delChat.reduce((a, b) => (a.propuesta.creadoEn >= b.propuesta.creadoEn ? a : b)).propuesta;
}
