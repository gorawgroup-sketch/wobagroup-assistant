import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { conMutex } from "../utils/asyncMutex";

export interface PendienteDesambiguacion {
  /**
   * Bug real encontrado en vivo (2026-09-07): este store guardaba UN SOLO pendiente por chat, y
   * guardarPendienteDesambiguacion BORRABA cualquier pendiente previo del mismo chat al guardar uno
   * nuevo. Cuando un correo trae varios adjuntos ambiguos (ej. 2 invitaciones .ics),
   * processClassification.ts manda una pregunta de desambiguación POR CADA UNO, cada una diciendo
   * explícitamente "cada uno es una decisión independiente" — pero la segunda pregunta borraba el
   * pendiente de la primera, dejando su botón "❌ Descartar" apuntando a un id que ya no existe ("Ese
   * botón ya no corresponde..."), justo lo que ese texto decía que NO iba a pasar. Ahora el store
   * guarda TODOS los pendientes de un chat a la vez — cada botón "Descartar" usa
   * consumirPendienteDesambiguacionPorId (por id Y chatId, nunca solo por chat) así que SIEMPRE
   * funciona sin importar en qué orden se respondan; una respuesta de texto libre (que no trae id)
   * resuelve la más antigua primero (ver consumirPendienteDesambiguacion).
   *
   * El campo `id` en sí viene de un bug anterior (2026-09-03): antes de existir, un botón de una
   * pregunta VIEJA ya reemplazada podía descartar el pendiente ACTUAL sin relación con ese botón —
   * el id permite verificar que el botón tocado corresponde de verdad a SU pregunta, nunca a otra.
   */
  id: string;
  chatId: number;
  /** Telegram message id que demuestra que la pregunta llego a ser visible. Cero = outbox provisional. */
  messageId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  nombreParaClasificar: string;
  captionOriginal?: string;
  preguntaFormulada: string;
  creadoEn: number;
  /** Si el archivo vino de un correo, sus datos — para poder responderlo después de archivar. */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; deColaCorreo?: boolean; /** Gmail interno (correo.id) + attachmentId del adjunto real — permite volver a descargarlo de Gmail si la copia local en tmp/uploads se pierde (ej. un redeploy de Railway entre que se descarga y que se usa). */ mensajeIdGmail?: string; attachmentIdGmail?: string; /** Identidad ESTABLE del adjunto entre lecturas del correo (a diferencia de attachmentIdGmail) — ver AdjuntoCorreo.partId en gmail/client.ts. Se usa para "¿ya procesé este adjunto?", nunca para descargar. */ partId?: string };
  /**
   * Hallazgo real de auditoría (Footprint, Modelo 303/349, 2026-09-17): la pregunta ya mencionaba las
   * carpetas reales candidatas por nombre en `preguntaFormulada` (texto libre), pero no había NINGÚN
   * botón para elegir una directamente — el usuario tenía que escribirla a mano. `empresa` (ya
   * identificada, aunque la carpeta no) y `carpetasCandidatas` (nombres EXACTOS de Drive, mismos que
   * el clasificador ya vio con listar_carpetas_drive) permiten ofrecer un botón por candidata que
   * archiva directo — ver processClassification.ts / documentCallbackHandler.ts (desamb_elegir).
   */
  empresa?: string;
  carpetasCandidatas?: string[];
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_pendientes_desambiguacion_docs";
// Mismo bug real que classificationStore.ts (ver su comentario): este store
// vivía en un archivo JSON local, que se pierde en cada redeploy — migrado
// a Sheets para que sobreviva, mismo patrón que el resto del proyecto.

// Pedido explícito de Carlos: procesa el correo/documentos entrantes por
// lotes y puede tardar horas en llegar a cada pregunta pendiente — 24h
// cubre un día completo de trabajo (mismo criterio en todos los
// "pendiente_*" de 30 min, ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;
const CLAVE_MUTEX = `pendientes-desambiguacion:${TAB_NAME}`;

const HEADERS = [
  "id",
  "chatId",
  "rutaLocal",
  "nombreArchivoOriginal",
  "mimeType",
  "nombreParaClasificar",
  "captionOriginal",
  "preguntaFormulada",
  "creadoEn",
  "correoOrigenJSON",
  "empresa",
  "carpetasCandidatasJSON",
  // Aditiva al final: conserva alineadas las filas historicas.
  "messageId",
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
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A1:M1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
    return tabGridId;
  }

  const addResp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
  });

  const newSheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId == null) {
    throw new Error("No se pudo crear la pestaña de pendientes de desambiguación.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:M1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToPendiente(row: unknown[]): PendienteDesambiguacion | null {
  if (!row[1]) return null;

  let correoOrigen: PendienteDesambiguacion["correoOrigen"];
  try {
    correoOrigen = row[9] ? JSON.parse(String(row[9])) : undefined;
  } catch {
    correoOrigen = undefined;
  }

  let carpetasCandidatas: string[] | undefined;
  try {
    carpetasCandidatas = row[11] ? JSON.parse(String(row[11])) : undefined;
  } catch {
    carpetasCandidatas = undefined;
  }

  return {
    // Filas de antes de agregar esta columna no tienen id — se cae al
    // chatId+creadoEn como identificador estable de todas formas único para
    // esa fila, en vez de dejarlo vacío.
    id: row[0] ? String(row[0]) : `${row[1]}-${row[8]}`,
    chatId: Number(row[1]) || 0,
    messageId: Number(row[12]) || 0,
    rutaLocal: row[2] ? String(row[2]) : "",
    nombreArchivoOriginal: row[3] ? String(row[3]) : "",
    mimeType: row[4] ? String(row[4]) : undefined,
    nombreParaClasificar: row[5] ? String(row[5]) : "",
    captionOriginal: row[6] ? String(row[6]) : undefined,
    preguntaFormulada: row[7] ? String(row[7]) : "",
    creadoEn: Number(row[8]) || 0,
    correoOrigen,
    empresa: row[10] ? String(row[10]) : undefined,
    carpetasCandidatas,
  };
}

function pendienteToRow(p: PendienteDesambiguacion): (string | number)[] {
  return [
    p.id,
    p.chatId,
    p.rutaLocal,
    p.nombreArchivoOriginal,
    p.mimeType ?? "",
    p.nombreParaClasificar,
    p.captionOriginal ?? "",
    p.preguntaFormulada,
    p.creadoEn,
    p.correoOrigen ? JSON.stringify(p.correoOrigen) : "",
    p.empresa ?? "",
    p.carpetasCandidatas && p.carpetasCandidatas.length > 0 ? JSON.stringify(p.carpetasCandidatas) : "",
    p.messageId,
  ];
}

interface FilaConIndice {
  rowIndex: number;
  pendiente: PendienteDesambiguacion;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:M10000`,
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

function pendienteVencido(p: PendienteDesambiguacion): boolean {
  return !p.correoOrigen?.deColaCorreo && Date.now() - p.creadoEn > TTL_MS;
}

async function purgarVencidas(todas: FilaConIndice[]): Promise<FilaConIndice[]> {
  const vencidas = todas.filter(({ pendiente }) => pendienteVencido(pendiente));
  const vigentes = todas.filter(({ pendiente }) => !pendienteVencido(pendiente));

  for (const { rowIndex } of vencidas.slice().sort((a, b) => b.rowIndex - a.rowIndex)) {
    await eliminarFila(rowIndex).catch((error) =>
      console.error("[disambiguationStore] Error purgando fila vencida (no crítico):", error)
    );
  }

  return vigentes;
}

/**
 * Guarda una pregunta MÁS de desambiguación para este chat — YA NO reemplaza pendientes previos del
 * mismo chat (ver el comentario en la interfaz, arriba): pueden coexistir varias a la vez, una por
 * cada adjunto ambiguo de un mismo correo. Devuelve el objeto creado (con su `id` nuevo) para que el
 * llamador lo incluya en el callback_data del botón "❌ Descartar" — ese botón siempre resuelve por
 * id (consumirPendienteDesambiguacionPorId), nunca por chat, así que funciona sin importar cuántas
 * otras preguntas sigan pendientes o en qué orden se respondan.
 */
export async function guardarPendienteDesambiguacion(
  datos: Omit<PendienteDesambiguacion, "creadoEn" | "id">
): Promise<PendienteDesambiguacion> {
  return conMutex(CLAVE_MUTEX, async () => {
    await purgarVencidas(await leerTodas());

    const sheetId = assertSheetId();
    const sheets = getClient();
    await ensureTab();

    const pendiente: PendienteDesambiguacion = { ...datos, id: randomUUID(), creadoEn: Date.now() };

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A:M`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [pendienteToRow(pendiente)] },
    });

    return pendiente;
  });
}

/** Confirma la entrega del outbox solo despues de que Telegram devolvio un message_id real. */
export async function actualizarMessageIdDesambiguacion(
  id: string,
  chatId: number,
  messageId: number
): Promise<PendienteDesambiguacion | undefined> {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return undefined;
  return conMutex(CLAVE_MUTEX, async () => {
    const fila = (await leerTodas()).find(({ pendiente }) => pendiente.id === id && pendiente.chatId === chatId);
    if (!fila) return undefined;
    const actualizada = { ...fila.pendiente, messageId };
    await getClient().spreadsheets.values.update({
      spreadsheetId: assertSheetId(),
      range: `${TAB_NAME}!A${fila.rowIndex}:M${fila.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [pendienteToRow(actualizada)] },
    });
    return actualizada;
  });
}

/** Restaura el mismo pendiente tras un fallo, conservando los callback_data existentes. */
export async function restaurarPendienteDesambiguacion(
  pendiente: PendienteDesambiguacion
): Promise<PendienteDesambiguacion> {
  return conMutex(CLAVE_MUTEX, async () => {
    const existente = (await leerTodas()).find(({ pendiente: actual }) =>
      actual.id === pendiente.id && actual.chatId === pendiente.chatId)?.pendiente;
    if (existente) return existente;
    const restaurado = { ...pendiente, creadoEn: Date.now() };
    await ensureTab();
    await getClient().spreadsheets.values.append({
      spreadsheetId: assertSheetId(),
      range: `${TAB_NAME}!A:M`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [pendienteToRow(restaurado)] },
    });
    return restaurado;
  });
}

/** Las pendientes de un chat, de más antigua a más reciente — orden que usan tanto el consumo por texto libre como la lectura para el resumen diario. */
function porAntiguedad(filas: FilaConIndice[], chatId: number): FilaConIndice[] {
  return filas.filter(({ pendiente }) => pendiente.chatId === chatId).sort((a, b) => a.pendiente.creadoEn - b.pendiente.creadoEn);
}

/**
 * Resuelve una respuesta de TEXTO LIBRE (no trae id, ver server.ts) — como puede haber varias
 * preguntas pendientes a la vez para el mismo chat, se consume siempre la MÁS ANTIGUA (a diferencia
 * de classificationStore.ts, que resuelve la más RECIENTE para sus propios botones — acá aplica
 * porque el texto libre responde una cola de preguntas en el orden en que se hicieron, no la última
 * propuesta vista). undefined si no hay ninguna o todas vencieron.
 */
export async function consumirPendienteDesambiguacion(chatId: number): Promise<PendienteDesambiguacion | undefined> {
  return conMutex(CLAVE_MUTEX, async () => {
    const todas = await leerTodas();
    const vigentes = await purgarVencidas(todas);

    // Una fila messageId=0 es un outbox que nunca confirmo entrega. El texto
    // libre del operador no puede aplicarse a una pregunta que no vio.
    const match = porAntiguedad(vigentes, chatId).find(({ pendiente }) => pendiente.messageId > 0);
    if (!match) return undefined;

    await eliminarFila(match.rowIndex);
    return match.pendiente;
  });
}

/**
 * Resuelve el botón "❌ Descartar" de UNA pregunta específica — por id Y chatId (hallazgo real de
 * auditoría: sin exigir también el chatId del chat que tocó el botón, el id por sí solo no garantiza
 * que la pregunta sea de ESE chat; con varios admins cada uno con sus propios pendientes, un id que
 * se filtrara o colisionara entre chats podría dejar que uno borre/avance la cola de otro).
 */
export async function consumirPendienteDesambiguacionPorId(id: string, chatId: number): Promise<PendienteDesambiguacion | undefined> {
  return conMutex(CLAVE_MUTEX, async () => {
    const todas = await leerTodas();
    const vigentes = await purgarVencidas(todas);

    const match = vigentes.find(({ pendiente }) => pendiente.id === id && pendiente.chatId === chatId);
    if (!match) return undefined;

    await eliminarFila(match.rowIndex);
    return match.pendiente;
  });
}

/** Lectura sin consumir de TODAS las pendientes de este chat (más antigua primero) — para el resumen diario (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerPendienteDesambiguacionPorChat(chatId: number): Promise<PendienteDesambiguacion[]> {
  return conMutex(CLAVE_MUTEX, async () => {
    const todas = await leerTodas();
    const vigentes = await purgarVencidas(todas);
    return porAntiguedad(vigentes, chatId)
      .map(({ pendiente }) => pendiente)
      .filter((pendiente) => pendiente.messageId > 0);
  });
}
