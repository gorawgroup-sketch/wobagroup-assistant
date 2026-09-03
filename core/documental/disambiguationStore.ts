import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

export interface PendienteDesambiguacion {
  /**
   * Bug real encontrado en auditoría (2026-09-03): el botón "❌ Descartar" se
   * agregó primero SIN id (callback_data "desamb_descartar" a secas), porque
   * este store solo guarda un pendiente por chat — parecía inambiguo. Pero
   * un botón de una pregunta VIEJA (ya reemplazada por un documento más
   * reciente del mismo chat) sigue visible y tocable en el historial de
   * Telegram, y sin id no había forma de distinguir "el usuario quiere
   * descartar ESTA pregunta" de "el usuario tocó un botón viejo" — podía
   * descartar el documento ACTUAL sin relación con el botón. El id permite
   * verificar que el botón tocado corresponde de verdad al pendiente vigente
   * antes de descartar nada.
   */
  id: string;
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  nombreParaClasificar: string;
  captionOriginal?: string;
  preguntaFormulada: string;
  creadoEn: number;
  /** Si el archivo vino de un correo, sus datos — para poder responderlo después de archivar. */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; deColaCorreo?: boolean; /** Gmail interno (correo.id) + attachmentId del adjunto real — permite volver a descargarlo de Gmail si la copia local en tmp/uploads se pierde (ej. un redeploy de Railway entre que se descarga y que se usa). */ mensajeIdGmail?: string; attachmentIdGmail?: string };
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
    throw new Error("No se pudo crear la pestaña de pendientes de desambiguación.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:J1`,
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

  return {
    // Filas de antes de agregar esta columna no tienen id — se cae al
    // chatId+creadoEn como identificador estable de todas formas único para
    // esa fila, en vez de dejarlo vacío.
    id: row[0] ? String(row[0]) : `${row[1]}-${row[8]}`,
    chatId: Number(row[1]) || 0,
    rutaLocal: row[2] ? String(row[2]) : "",
    nombreArchivoOriginal: row[3] ? String(row[3]) : "",
    mimeType: row[4] ? String(row[4]) : undefined,
    nombreParaClasificar: row[5] ? String(row[5]) : "",
    captionOriginal: row[6] ? String(row[6]) : undefined,
    preguntaFormulada: row[7] ? String(row[7]) : "",
    creadoEn: Number(row[8]) || 0,
    correoOrigen,
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
    range: `${TAB_NAME}!A2:J10000`,
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
  return Date.now() - p.creadoEn > TTL_MS;
}

async function purgarVencidas(todas: FilaConIndice[]): Promise<FilaConIndice[]> {
  const vencidas = todas.filter(({ pendiente }) => pendienteVencido(pendiente));
  const vigentes = todas.filter(({ pendiente }) => !pendienteVencido(pendiente));

  vencidas
    .slice()
    .sort((a, b) => b.rowIndex - a.rowIndex)
    .forEach(({ rowIndex }) => {
      eliminarFila(rowIndex).catch((error) =>
        console.error("[disambiguationStore] Error purgando fila vencida (no crítico):", error)
      );
    });

  return vigentes;
}

/**
 * Guarda (reemplazando cualquier pendiente previo del mismo chat) la
 * pregunta de desambiguación que se le acaba de mandar al usuario, para
 * poder conectarla con su próxima respuesta de texto. Devuelve el objeto
 * creado (con su `id` nuevo) para que el llamador pueda incluirlo en el
 * callback_data del botón "❌ Descartar" — así un botón viejo (de una
 * pregunta ya reemplazada) nunca puede descartar el pendiente ACTUAL de ese
 * chat por error (ver el comentario en la interfaz, arriba).
 */
export async function guardarPendienteDesambiguacion(
  datos: Omit<PendienteDesambiguacion, "creadoEn" | "id">
): Promise<PendienteDesambiguacion> {
  const todas = await leerTodas();
  const vigentes = await purgarVencidas(todas);

  const delMismoChat = vigentes.filter(({ pendiente }) => pendiente.chatId === datos.chatId);
  for (const { rowIndex } of delMismoChat.sort((a, b) => b.rowIndex - a.rowIndex)) {
    await eliminarFila(rowIndex);
  }

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const pendiente: PendienteDesambiguacion = { ...datos, id: randomUUID(), creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [pendienteToRow(pendiente)] },
  });

  return pendiente;
}

/**
 * Si hay una pregunta de desambiguación pendiente para este chat, la
 * devuelve y la elimina (se consume con la respuesta). undefined si no hay
 * ninguna o ya venció.
 */
export async function consumirPendienteDesambiguacion(chatId: number): Promise<PendienteDesambiguacion | undefined> {
  const todas = await leerTodas();
  const vigentes = await purgarVencidas(todas);

  const match = vigentes.find(({ pendiente }) => pendiente.chatId === chatId);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.pendiente;
}

/** Lectura sin consumir — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerPendienteDesambiguacionPorChat(chatId: number): Promise<PendienteDesambiguacion | undefined> {
  const todas = await leerTodas();
  const vigentes = await purgarVencidas(todas);
  return vigentes.find(({ pendiente }) => pendiente.chatId === chatId)?.pendiente;
}
