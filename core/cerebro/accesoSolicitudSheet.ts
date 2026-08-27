import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_cerebro_solicitudes_acceso";

// Ventanas distintas: una solicitud nunca resuelta se purga a los 10
// minutos (nadie la va a aprobar ya); una ya resuelta se purga a los 5
// minutos DESPUÉS de resolverse — tiempo de sobra para que el polling del
// front la recoja, minimizando cuánto tiempo queda el token real (o la key
// maestra) sentado como texto plano en una fila del Sheet.
const TTL_PENDIENTE_MS = 10 * 60 * 1000;
const TTL_RESUELTO_MS = 5 * 60 * 1000;

export type EstadoSolicitud = "pendiente" | "aprobado_temporal" | "aprobado_maestro" | "rechazado";

export interface NotificacionEnviada {
  chatId: number;
  messageId: number;
}

export interface SolicitudAcceso {
  id: string;
  nombre: string;
  estado: EstadoSolicitud;
  token?: string;
  notificaciones: NotificacionEnviada[];
  creadoEn: number;
  resueltoEn?: number;
}

/**
 * Solicitudes de acceso al front del cerebro (persona escribe su nombre →
 * pide acceso → todos los admins reciben botones en Telegram) — pestaña
 * oculta del Sheet de cashflow, mismo patrón que el resto de los stores de
 * propuestas pendientes. A diferencia de esos, esta fila SIGUE viva después
 * de "resuelta" un rato (ver TTL_RESUELTO_MS): el front la sigue consultando
 * por polling hasta ver el resultado, así que no se puede borrar apenas se
 * aprueba/rechaza como hacen gastoProposalSheet.ts etc.
 */
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

const HEADERS = ["id", "nombre", "estado", "token", "notificacionesJSON", "creadoEn", "resueltoEn"];

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
    throw new Error("No se pudo crear la pestaña de solicitudes de acceso al cerebro.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:G1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToSolicitud(row: unknown[]): SolicitudAcceso | null {
  if (!row[0]) return null;

  let notificaciones: NotificacionEnviada[] = [];
  try {
    notificaciones = row[4] ? JSON.parse(String(row[4])) : [];
  } catch {
    notificaciones = [];
  }

  return {
    id: String(row[0]),
    nombre: row[1] ? String(row[1]) : "",
    estado: (row[2] as EstadoSolicitud) || "pendiente",
    token: row[3] ? String(row[3]) : undefined,
    notificaciones,
    creadoEn: Number(row[5]) || 0,
    resueltoEn: row[6] ? Number(row[6]) : undefined,
  };
}

function solicitudToRow(s: SolicitudAcceso): (string | number)[] {
  return [
    s.id,
    s.nombre,
    s.estado,
    s.token ?? "",
    JSON.stringify(s.notificaciones),
    s.creadoEn,
    s.resueltoEn ?? "",
  ];
}

interface FilaConIndice {
  rowIndex: number;
  solicitud: SolicitudAcceso;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:G10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    const solicitud = rowToSolicitud(row);
    if (solicitud) result.push({ rowIndex: i + 2, solicitud });
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

  const vencidas = todas.filter(({ solicitud }) => {
    if (solicitud.estado === "pendiente") return ahora - solicitud.creadoEn > TTL_PENDIENTE_MS;
    return !!solicitud.resueltoEn && ahora - solicitud.resueltoEn > TTL_RESUELTO_MS;
  });

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

export async function crearSolicitudAcceso(nombre: string): Promise<SolicitudAcceso> {
  await purgarVencidas();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const solicitud: SolicitudAcceso = {
    id: randomUUID(),
    nombre,
    estado: "pendiente",
    notificaciones: [],
    creadoEn: Date.now(),
  };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:G`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [solicitudToRow(solicitud)] },
  });

  return solicitud;
}

/** Guarda a qué chats/mensajes de Telegram se mandó la notificación, para poder editarlos todos al resolver. */
export async function registrarNotificaciones(id: string, notificaciones: NotificacionEnviada[]): Promise<void> {
  const todas = await leerTodas();
  const match = todas.find(({ solicitud }) => solicitud.id === id);
  if (!match) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!E${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[JSON.stringify(notificaciones)]] },
  });
}

export async function obtenerSolicitudAcceso(id: string): Promise<SolicitudAcceso | undefined> {
  const todas = await leerTodas();
  return todas.find(({ solicitud }) => solicitud.id === id)?.solicitud;
}

/** Resuelve la solicitud (aprobada temporal/maestro, o rechazada) — actualiza en el lugar, NO borra la fila. */
export async function resolverSolicitudAcceso(
  id: string,
  estado: Exclude<EstadoSolicitud, "pendiente">,
  token?: string
): Promise<SolicitudAcceso | undefined> {
  const todas = await leerTodas();
  const match = todas.find(({ solicitud }) => solicitud.id === id);
  if (!match) return undefined;

  const sheetId = assertSheetId();
  const sheets = getClient();
  const resueltoEn = Date.now();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!C${match.rowIndex}:D${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[estado, token ?? ""]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!G${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[resueltoEn]] },
  });

  return { ...match.solicitud, estado, token, resueltoEn };
}
