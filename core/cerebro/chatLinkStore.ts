import { createHash, randomBytes, randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_cerebro_vinculos_chat";
const TTL_CODIGO_MS = 10 * 60 * 1000;
const HEADERS = [
  "id",
  "deviceHash",
  "nombreSolicitud",
  "codigoHash",
  "estado",
  "telegramUserId",
  "nombreTelegram",
  "creadoEn",
  "expiraEn",
  "vinculadoEn",
];

export type EstadoVinculoChat = "pendiente" | "vinculado";

export interface VinculoChat {
  id: string;
  deviceHash: string;
  nombreSolicitud: string;
  estado: EstadoVinculoChat;
  telegramUserId?: number;
  nombreTelegram?: string;
  creadoEn: number;
  expiraEn: number;
  vinculadoEn?: number;
}

interface FilaVinculo extends VinculoChat {
  codigoHash: string;
}

interface FilaConIndice {
  rowIndex: number;
  fila: FilaVinculo;
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
  if (nuevoId == null) throw new Error("No se pudo crear la pestaña de vínculos del chat.");

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:J1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
  tabGridId = nuevoId;
  return nuevoId;
}

export function hashVinculo(valor: string): string {
  return createHash("sha256").update(valor).digest("hex");
}

export function normalizarCodigoVinculo(codigo: string): string {
  return codigo.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizarNombreVinculo(nombre: string): string {
  return nombre.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

function rowToFila(row: unknown[]): FilaVinculo | null {
  if (!row[0] || !row[1]) return null;
  return {
    id: String(row[0]),
    deviceHash: String(row[1]),
    nombreSolicitud: row[2] ? String(row[2]) : "",
    codigoHash: row[3] ? String(row[3]) : "",
    estado: row[4] === "vinculado" ? "vinculado" : "pendiente",
    telegramUserId: row[5] ? Number(row[5]) : undefined,
    nombreTelegram: row[6] ? String(row[6]) : undefined,
    creadoEn: Number(row[7]) || 0,
    expiraEn: Number(row[8]) || 0,
    vinculadoEn: row[9] ? Number(row[9]) : undefined,
  };
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const resp = await getClient().spreadsheets.values.get({
    spreadsheetId: assertSheetId(),
    range: `${TAB_NAME}!A2:J10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const resultado: FilaConIndice[] = [];
  (resp.data.values ?? []).forEach((row, index) => {
    const fila = rowToFila(row);
    if (fila) resultado.push({ rowIndex: index + 2, fila });
  });
  return resultado;
}

async function purgarCodigosVencidos(): Promise<void> {
  const ahora = Date.now();
  const vencidos = (await leerTodas())
    .filter(({ fila }) => fila.estado === "pendiente" && fila.expiraEn <= ahora)
    .sort((a, b) => b.rowIndex - a.rowIndex);
  if (vencidos.length === 0) return;
  const gridId = await ensureTab();
  await getClient().spreadsheets.batchUpdate({
    spreadsheetId: assertSheetId(),
    requestBody: {
      requests: vencidos.map(({ rowIndex }) => ({
        deleteDimension: {
          range: { sheetId: gridId, dimension: "ROWS", startIndex: rowIndex - 1, endIndex: rowIndex },
        },
      })),
    },
  });
}

function sinHashes(fila: FilaVinculo): VinculoChat {
  const { codigoHash: _codigoHash, ...vinculo } = fila;
  return vinculo;
}

export async function obtenerVinculoChat(deviceId: string, nombreSolicitud?: string): Promise<VinculoChat | undefined> {
  const deviceHash = hashVinculo(deviceId);
  const nombreNormalizado = nombreSolicitud ? normalizarNombreVinculo(nombreSolicitud) : "";
  const todas = await leerTodas();
  const vinculadas = todas
    .map(({ fila }) => fila)
    .filter(
      (fila) =>
        fila.deviceHash === deviceHash &&
        fila.estado === "vinculado" &&
        fila.telegramUserId &&
        (!nombreNormalizado || normalizarNombreVinculo(fila.nombreSolicitud) === nombreNormalizado)
    )
    .sort((a, b) => (b.vinculadoEn ?? 0) - (a.vinculadoEn ?? 0));
  return vinculadas[0] ? sinHashes(vinculadas[0]) : undefined;
}

const ALFABETO_CODIGO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function crearCodigo(): string {
  const bytes = randomBytes(6);
  const chars = Array.from(bytes, (byte) => ALFABETO_CODIGO[byte % ALFABETO_CODIGO.length]);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3).join("")}`;
}

export async function crearSolicitudVinculoChat(
  deviceId: string,
  nombreSolicitud: string
): Promise<{ estado: EstadoVinculoChat; codigo?: string; expiraEn?: number; telegramUserId?: number }> {
  await purgarCodigosVencidos();
  const existente = await obtenerVinculoChat(deviceId, nombreSolicitud);
  if (existente?.telegramUserId) {
    return { estado: "vinculado", telegramUserId: existente.telegramUserId };
  }

  const codigo = crearCodigo();
  const creadoEn = Date.now();
  const expiraEn = creadoEn + TTL_CODIGO_MS;
  await ensureTab();
  await getClient().spreadsheets.values.append({
    spreadsheetId: assertSheetId(),
    range: `${TAB_NAME}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        randomUUID(),
        hashVinculo(deviceId),
        nombreSolicitud,
        hashVinculo(normalizarCodigoVinculo(codigo)),
        "pendiente",
        "",
        "",
        creadoEn,
        expiraEn,
        "",
      ]],
    },
  });
  return { estado: "pendiente", codigo, expiraEn };
}

export async function confirmarVinculoChat(
  codigo: string,
  telegramUserId: number,
  nombreTelegram: string
): Promise<VinculoChat | undefined> {
  const codigoNormalizado = normalizarCodigoVinculo(codigo);
  if (codigoNormalizado.length !== 6) return undefined;

  const todas = await leerTodas();
  const ahora = Date.now();
  const match = todas.find(
    ({ fila }) =>
      fila.estado === "pendiente" &&
      fila.expiraEn > ahora &&
      fila.codigoHash === hashVinculo(codigoNormalizado)
  );
  if (!match) return undefined;

  await getClient().spreadsheets.values.update({
    spreadsheetId: assertSheetId(),
    range: `${TAB_NAME}!E${match.rowIndex}:J${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["vinculado", telegramUserId, nombreTelegram, match.fila.creadoEn, match.fila.expiraEn, ahora]],
    },
  });
  return sinHashes({
    ...match.fila,
    estado: "vinculado",
    telegramUserId,
    nombreTelegram,
    vinculadoEn: ahora,
  });
}
