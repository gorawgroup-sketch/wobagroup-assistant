import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

export interface PendienteDesambiguacion {
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  nombreParaClasificar: string;
  captionOriginal?: string;
  preguntaFormulada: string;
  creadoEn: number;
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_pendientes_desambiguacion_docs";
// Mismo bug real que classificationStore.ts (ver su comentario): este store
// vivía en un archivo JSON local, que se pierde en cada redeploy — migrado
// a Sheets para que sobreviva, mismo patrón que el resto del proyecto.

// Corta a propósito (30 min): se espera una respuesta casi inmediata a la
// pregunta de desambiguación, no días después.
const TTL_MS = 30 * 60 * 1000;

const HEADERS = [
  "chatId",
  "rutaLocal",
  "nombreArchivoOriginal",
  "mimeType",
  "nombreParaClasificar",
  "captionOriginal",
  "preguntaFormulada",
  "creadoEn",
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
    range: `${TAB_NAME}!A1:H1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToPendiente(row: unknown[]): PendienteDesambiguacion | null {
  if (!row[0]) return null;
  return {
    chatId: Number(row[0]) || 0,
    rutaLocal: row[1] ? String(row[1]) : "",
    nombreArchivoOriginal: row[2] ? String(row[2]) : "",
    mimeType: row[3] ? String(row[3]) : undefined,
    nombreParaClasificar: row[4] ? String(row[4]) : "",
    captionOriginal: row[5] ? String(row[5]) : undefined,
    preguntaFormulada: row[6] ? String(row[6]) : "",
    creadoEn: Number(row[7]) || 0,
  };
}

function pendienteToRow(p: PendienteDesambiguacion): (string | number)[] {
  return [
    p.chatId,
    p.rutaLocal,
    p.nombreArchivoOriginal,
    p.mimeType ?? "",
    p.nombreParaClasificar,
    p.captionOriginal ?? "",
    p.preguntaFormulada,
    p.creadoEn,
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
 * poder conectarla con su próxima respuesta de texto.
 */
export async function guardarPendienteDesambiguacion(datos: Omit<PendienteDesambiguacion, "creadoEn">): Promise<void> {
  const todas = await leerTodas();
  const vigentes = await purgarVencidas(todas);

  const delMismoChat = vigentes.filter(({ pendiente }) => pendiente.chatId === datos.chatId);
  for (const { rowIndex } of delMismoChat.sort((a, b) => b.rowIndex - a.rowIndex)) {
    await eliminarFila(rowIndex);
  }

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const pendiente: PendienteDesambiguacion = { ...datos, creadoEn: Date.now() };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:H`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [pendienteToRow(pendiente)] },
  });
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
