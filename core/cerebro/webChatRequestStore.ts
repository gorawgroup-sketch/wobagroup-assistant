import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { CacheLectura } from "../utils/readCache";
import type {
  RepositorioSolicitudesChat,
  SolicitudChatGuardada,
  EstadoSolicitudChat,
} from "./webChatCoordinator";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_cerebro_chat_solicitudes";
const HEADERS = ["requestId", "chatId", "textoHash", "estado", "respuesta", "creadoEn", "actualizadoEn"];
const TTL_SOLICITUD_MS = 48 * 60 * 60 * 1000;
let ultimaPurgaEn = 0;
const filasMemoria = new Map<string, FilaConIndice>();

function claveSolicitud(chatId: number, requestId: string): string {
  return `${chatId}:${requestId}`;
}

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
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
  const sheets = getClient();
  const sheetId = assertSheetId();
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
  const nuevoId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (nuevoId == null) throw new Error("No se pudo crear la pestaña de idempotencia del chat.");
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:G1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
  tabGridId = nuevoId;
  return nuevoId;
}

interface FilaConIndice {
  rowIndex: number;
  solicitud: SolicitudChatGuardada;
}

const cacheSolicitudes = new CacheLectura<FilaConIndice[]>("solicitudes_chat", 60_000);

async function leerTodas(): Promise<FilaConIndice[]> {
  const filas = (await cacheSolicitudes.obtener(async () => {
    await ensureTab();
    const resp = await getClient().spreadsheets.values.get({
      spreadsheetId: assertSheetId(),
      range: `${TAB_NAME}!A2:G10000`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const resultado: FilaConIndice[] = [];
    (resp.data.values ?? []).forEach((row, index) => {
      if (!row[0] || !row[1]) return;
      resultado.push({
        rowIndex: index + 2,
        solicitud: {
          requestId: String(row[0]),
          chatId: Number(row[1]),
          textoHash: String(row[2] ?? ""),
          estado: (row[3] as EstadoSolicitudChat) || "fallido",
          respuesta: row[4] ? String(row[4]) : undefined,
          creadoEn: Number(row[5]) || 0,
          actualizadoEn: Number(row[6]) || 0,
        },
      });
    });
    return resultado;
  })).datos;
  for (const fila of filas) {
    filasMemoria.set(claveSolicitud(fila.solicitud.chatId, fila.solicitud.requestId), fila);
  }
  return filas;
}

async function actualizar(
  chatId: number,
  requestId: string,
  estado: EstadoSolicitudChat,
  respuesta = ""
): Promise<void> {
  const llave = claveSolicitud(chatId, requestId);
  const match = filasMemoria.get(llave) ?? (await leerTodas()).find(
    ({ solicitud }) => solicitud.chatId === chatId && solicitud.requestId === requestId
  );
  if (!match) throw new Error("No existe la reserva idempotente del mensaje.");
  await getClient().spreadsheets.values.update({
    spreadsheetId: assertSheetId(),
    range: `${TAB_NAME}!D${match.rowIndex}:G${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[estado, respuesta, match.solicitud.creadoEn, Date.now()]],
    },
  });
  filasMemoria.set(llave, {
    rowIndex: match.rowIndex,
    solicitud: { ...match.solicitud, estado, respuesta: respuesta || undefined, actualizadoEn: Date.now() },
  });
  cacheSolicitudes.invalidar();
}

async function purgarSolicitudesAntiguas(): Promise<void> {
  const ahora = Date.now();
  if (ahora - ultimaPurgaEn < 6 * 60 * 60 * 1000) return;
  const antiguas = (await leerTodas())
    .filter(({ solicitud }) => ahora - solicitud.creadoEn > TTL_SOLICITUD_MS)
    .sort((a, b) => b.rowIndex - a.rowIndex);
  if (antiguas.length === 0) {
    ultimaPurgaEn = ahora;
    return;
  }
  const gridId = await ensureTab();
  await getClient().spreadsheets.batchUpdate({
    spreadsheetId: assertSheetId(),
    requestBody: {
      requests: antiguas.map(({ rowIndex }) => ({
        deleteDimension: {
          range: { sheetId: gridId, dimension: "ROWS", startIndex: rowIndex - 1, endIndex: rowIndex },
        },
      })),
    },
  });
  filasMemoria.clear();
  cacheSolicitudes.invalidar();
  ultimaPurgaEn = ahora;
}

export const webChatRequestStore: RepositorioSolicitudesChat = {
  async obtener(chatId, requestId) {
    const llave = claveSolicitud(chatId, requestId);
    const local = filasMemoria.get(llave);
    if (local) return { ...local.solicitud };
    const match = (await leerTodas()).find(
      ({ solicitud }) => solicitud.chatId === chatId && solicitud.requestId === requestId
    );
    return match ? { ...match.solicitud } : undefined;
  },

  async reservar(solicitud) {
    await ensureTab();
    await purgarSolicitudesAntiguas();
    const respuesta = await getClient().spreadsheets.values.append({
      spreadsheetId: assertSheetId(),
      range: `${TAB_NAME}!A:G`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          solicitud.requestId,
          solicitud.chatId,
          solicitud.textoHash,
          solicitud.estado,
          "",
          solicitud.creadoEn,
          solicitud.actualizadoEn,
        ]],
      },
    });
    const updatedRange = respuesta.data.updates?.updatedRange ?? "";
    const rowIndex = Number(updatedRange.match(/![A-Z]+(\d+):/i)?.[1]);
    if (Number.isInteger(rowIndex) && rowIndex >= 2) {
      filasMemoria.set(claveSolicitud(solicitud.chatId, solicitud.requestId), {
        rowIndex,
        solicitud: { ...solicitud },
      });
    }
    cacheSolicitudes.invalidar();
  },

  async completar(chatId, requestId, respuesta) {
    await actualizar(chatId, requestId, "completado", respuesta);
  },

  async marcarIncierto(chatId, requestId) {
    await actualizar(chatId, requestId, "incierto");
  },

  async fallar(chatId, requestId) {
    await actualizar(chatId, requestId, "fallido");
  },
};
