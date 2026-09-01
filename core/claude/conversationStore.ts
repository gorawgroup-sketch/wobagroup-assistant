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
//
// Pedido explícito, distinto del bug de arriba: esto NO debe acumularse sin
// límite. MAX_MESSAGES ya acota cuántos mensajes vivos guarda CADA chat,
// pero una fila que nadie vuelve a tocar se quedaba ahí para siempre. Por
// eso hay un TTL (TTL_HISTORIAL_MS): pasado ese tiempo sin actividad, la
// conversación se trata como si no existiera y la fila se purga — "se
// acuerda de la conversación reciente por un tiempo", no memoria
// indefinida. Esto es completamente aparte de CAPTURA (core/knowledge/
// capturaSheet.ts, pestaña _capturas): eso es conocimiento guardado a
// propósito y a mano, permanente, sin TTL — nunca se purga.
// Subido de 20 a 30 al empezar a registrar TAMBIÉN los mensajes salientes
// proactivos (cron/callbacks, ver registrarMensajeSaliente) — más volumen
// de mensajes por chat, para no desplazar la conversación real tan rápido.
const MAX_MESSAGES = 30;
const TTL_HISTORIAL_MS = 6 * 60 * 60 * 1000; // 6 horas — cubre una pausa normal (comida, una reunión), no una conversación de hace días

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
    tabAsegurada = true;
    tabGridId = existing.properties.sheetId;
    return tabGridId;
  }

  const addResp = await sheets.spreadsheets.batchUpdate({
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
  tabGridId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  return tabGridId;
}

interface FilaHistorial {
  rowIndex: number;
  chatId: number;
  mensajes: Anthropic.MessageParam[];
  actualizadoEn: number;
}

function filaVencida(actualizadoEn: number): boolean {
  return Date.now() - actualizadoEn > TTL_HISTORIAL_MS;
}

async function leerTodasLasFilas(): Promise<FilaHistorial[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:C10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  return rows.map((row, i) => {
    let mensajes: Anthropic.MessageParam[] = [];
    try {
      mensajes = row[1] ? JSON.parse(String(row[1])) : [];
    } catch {
      mensajes = []; // fila corrupta — mejor arrancar en limpio que tumbar la conversación
    }
    const actualizadoEn = row[2] ? new Date(String(row[2])).getTime() : 0;
    return { rowIndex: i + 2, chatId: Number(row[0]), mensajes, actualizadoEn };
  });
}

async function leerFila(chatId: number): Promise<FilaHistorial | undefined> {
  const todas = await leerTodasLasFilas();
  return todas.find((f) => f.chatId === chatId);
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

/**
 * Purga filas cuya última actividad supera el TTL — llamada en cada
 * guardarHistorial (mismo patrón que purgarVencidas en proposalSheet.ts),
 * así la pestaña nunca acumula conversaciones inactivas indefinidamente.
 */
async function purgarVencidas(): Promise<void> {
  const todas = await leerTodasLasFilas();
  const vencidas = todas.filter((f) => filaVencida(f.actualizadoEn));

  // De abajo hacia arriba para que borrar una fila no corra los índices de las siguientes.
  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex).catch((error) =>
      console.error("[conversationStore] Error purgando fila vencida (no crítico):", error)
    );
  }
}

/** Un turno nuevo siempre empieza con un mensaje de usuario en texto plano (nunca un tool_result). */
function esInicioDeTurno(mensaje: Anthropic.MessageParam): boolean {
  return mensaje.role === "user" && typeof mensaje.content === "string";
}

export async function obtenerHistorial(chatId: number): Promise<Anthropic.MessageParam[]> {
  try {
    const fila = await leerFila(chatId);
    if (!fila) return [];
    // Vencida: se trata como si no existiera — "recuerda por un tiempo",
    // no memoria indefinida. La fila en sí se limpia en la próxima purga
    // (guardarHistorial), no hace falta borrarla aquí también.
    if (filaVencida(fila.actualizadoEn)) return [];
    return fila.mensajes;
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
    await eliminarFila(fila.rowIndex);
  } catch (error) {
    console.error("[conversationStore] Error limpiando historial (no crítico):", error);
  }
}

/**
 * Pedido explícito de Carlos: "cualquier inquietud que tú tengas yo la
 * pueda responder desde el Chat y tú reconozcas y sigas el proceso" — no
 * solo para flujos específicos (archivo pendiente, contacto no encontrado,
 * ya cubiertos con stores dedicados), sino CUALQUIER pregunta/propuesta que
 * el asistente le mande por Telegram, venga de un cron, un callback, o el
 * chat normal. Se llama desde sendTelegramMessage/sendTelegramMessageWithButtons
 * (ver core/telegram/client.ts) para que ese texto quede en el MISMO
 * historial que usa askClaude — así, en el siguiente mensaje del usuario
 * (aunque sea texto libre, no un botón), el chat ya sabe qué se le
 * preguntó, sin necesitar un store dedicado por cada tipo de pregunta.
 * Verificado en vivo que la API de Anthropic acepta mensajes "assistant"
 * consecutivos y que el historial puede empezar en "assistant" — no hace
 * falta fusionar con el turno anterior para mantener una alternancia
 * estricta que en realidad no exige.
 */
export async function registrarMensajeSaliente(chatId: number, texto: string): Promise<void> {
  try {
    const historial = await obtenerHistorial(chatId);
    await guardarHistorial(chatId, [...historial, { role: "assistant", content: texto }]);
  } catch (error) {
    console.error("[conversationStore] Error registrando mensaje saliente (no crítico):", error);
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
    // Purga conversaciones inactivas ANTES de escribir esta — así la
    // pestaña nunca crece sin límite (pedido explícito: "no acumular tanta
    // información", solo recordar la conversación reciente por un tiempo).
    await purgarVencidas();

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
