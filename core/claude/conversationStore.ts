import type Anthropic from "@anthropic-ai/sdk";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

// Historial por chat de Telegram, para que preguntas de seguimiento ("envíale
// ese link a Carlos") tengan contexto de lo que se habló antes.
//
// Vivía SOLO en memoria del proceso (un Map) — se perdía en cada redeploy.
// Bug real reportado: "dejo el chat unos minutos y ya no se acuerda de
// nada" — con lo frecuente que se redeploya este proyecto (varias veces por
// hora en sesiones activas de desarrollo), cualquier redeploy en el medio
// borraba la conversación de TODOS los chats a la vez, sin ningún aviso.
// Ahora se guarda en la misma hoja de Sheets que ya usan _propuestas_
// pendientes, _correcciones, etc. — el único store de este tipo en el
// proyecto que todavía vivía solo en memoria.
const MAX_MESSAGES = 20;

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_historial_conversaciones";
const HEADERS = ["chatId", "mensajesJSON", "actualizadoEn"];

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
    range: `${TAB_NAME}!A1:C1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

interface FilaHistorial {
  rowIndex: number;
  chatId: number;
  mensajes: Anthropic.MessageParam[];
}

async function leerFila(chatId: number): Promise<FilaHistorial | undefined> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:C10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const idx = rows.findIndex((row) => Number(row[0]) === chatId);
  if (idx === -1) return undefined;

  let mensajes: Anthropic.MessageParam[] = [];
  try {
    mensajes = rows[idx][1] ? JSON.parse(String(rows[idx][1])) : [];
  } catch {
    mensajes = []; // fila corrupta — mejor arrancar en limpio que tumbar la conversación
  }

  return { rowIndex: idx + 2, chatId, mensajes };
}

/** Un turno nuevo siempre empieza con un mensaje de usuario en texto plano (nunca un tool_result). */
function esInicioDeTurno(mensaje: Anthropic.MessageParam): boolean {
  return mensaje.role === "user" && typeof mensaje.content === "string";
}

export async function obtenerHistorial(chatId: number): Promise<Anthropic.MessageParam[]> {
  try {
    const fila = await leerFila(chatId);
    return fila?.mensajes ?? [];
  } catch (error) {
    console.error("[conversationStore] Error leyendo historial (se sigue sin contexto previo):", error);
    return [];
  }
}

/** Descarta el historial de un chat — vía de escape si algo lo deja en un estado que la API rechaza. */
export async function limpiarHistorial(chatId: number): Promise<void> {
  try {
    const fila = await leerFila(chatId);
    if (!fila) return;
    const sheetId = assertSheetId();
    const sheets = getClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!B${fila.rowIndex}:C${fila.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [["[]", new Date().toISOString()]] },
    });
  } catch (error) {
    console.error("[conversationStore] Error limpiando historial (no crítico):", error);
  }
}

export async function guardarHistorial(chatId: number, mensajes: Anthropic.MessageParam[]): Promise<void> {
  let recortados = mensajes;

  if (mensajes.length > MAX_MESSAGES) {
    // No se puede cortar en cualquier índice: un turno con herramientas deja
    // varios mensajes intermedios (assistant con tool_use + user con
    // tool_result) que dependen unos de otros — cortar a mitad de eso deja un
    // tool_result "huérfano" al principio del array, y la API de Anthropic lo
    // rechaza con 400 invalid_request_error (bug real visto en producción).
    // Por eso se busca el inicio de turno más cercano al límite en vez de
    // cortar por índice fijo.
    const candidato = mensajes.length - MAX_MESSAGES;
    let inicio = candidato;
    while (inicio < mensajes.length && !esInicioDeTurno(mensajes[inicio])) {
      inicio++;
    }
    // Si no hay ningún inicio de turno válido en la cola candidata (un solo
    // turno con herramientas ocupó todo el margen), se conserva el array
    // completo — mejor un historial más largo de lo ideal que uno corrupto.
    recortados = inicio < mensajes.length ? mensajes.slice(inicio) : mensajes;
  }

  try {
    await ensureTab();
    const sheetId = assertSheetId();
    const sheets = getClient();
    const fila = await leerFila(chatId);
    const valores = [chatId, JSON.stringify(recortados), new Date().toISOString()];

    if (fila) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${fila.rowIndex}:C${fila.rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [valores] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A:C`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [valores] },
      });
    }
  } catch (error) {
    // No tumba el turno actual (ya se le respondió al usuario) — pero si
    // esto falla seguido, la conversación vuelve a perder memoria entre
    // turnos, así que se deja bien visible en logs.
    console.error("[conversationStore] Error guardando historial (la respuesta de este turno no se pierde, pero no quedó memoria para el siguiente):", error);
  }
}
