import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_usuarios_autorizados";
const HEADERS = ["userId", "rol", "nombre", "autorizadoEn"];

export type Rol = "admin" | "colaborador";

export interface UsuarioAutorizado {
  userId: number;
  rol: Rol;
  nombre: string;
  autorizadoEn: string;
}

/**
 * Lista de usuarios autorizados a usar el asistente, con nivel de acceso —
 * en una pestaña oculta del Sheet de cashflow, NO en una variable de entorno:
 * así se puede autorizar gente nueva con un botón desde Telegram (ver
 * core/telegram/adminNotify.ts), sin que alguien tenga que entrar a Railway
 * a mano cada vez.
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
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }],
    },
  });

  const newSheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId == null) {
    throw new Error("No se pudo crear la pestaña de usuarios autorizados.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:D1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToUsuario(row: unknown[]): UsuarioAutorizado | null {
  if (!row[0]) return null;
  return {
    userId: Number(row[0]),
    rol: row[1] === "admin" ? "admin" : "colaborador",
    nombre: row[2] ? String(row[2]) : "",
    autorizadoEn: row[3] ? String(row[3]) : "",
  };
}

interface FilaConIndice {
  rowIndex: number;
  usuario: UsuarioAutorizado;
}

async function leerTodos(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:D10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    const usuario = rowToUsuario(row);
    if (usuario) result.push({ rowIndex: i + 2, usuario });
  });
  return result;
}

/** Devuelve TODOS los usuarios autorizados (se cachea 60s para no pegarle a Sheets en cada mensaje). */
let cache: { data: UsuarioAutorizado[]; leidoEn: number } | null = null;
const CACHE_TTL_MS = 60_000;

export async function obtenerUsuariosAutorizados(): Promise<UsuarioAutorizado[]> {
  if (cache && Date.now() - cache.leidoEn < CACHE_TTL_MS) {
    return cache.data;
  }
  const filas = await leerTodos();
  const data = filas.map((f) => f.usuario);
  cache = { data, leidoEn: Date.now() };
  return data;
}

export function invalidarCacheUsuariosAutorizados(): void {
  cache = null;
}

export async function obtenerRolUsuario(userId: number | undefined): Promise<Rol | undefined> {
  if (!userId) return undefined;
  const usuarios = await obtenerUsuariosAutorizados();
  return usuarios.find((u) => u.userId === userId)?.rol;
}

export async function esUsuarioAutorizado(userId: number | undefined): Promise<boolean> {
  return (await obtenerRolUsuario(userId)) !== undefined;
}

export async function obtenerAdmins(): Promise<UsuarioAutorizado[]> {
  const usuarios = await obtenerUsuariosAutorizados();
  return usuarios.filter((u) => u.rol === "admin");
}

/** Autoriza (o actualiza el rol de) un usuario. Nunca borra a nadie — eso se hace a mano en el Sheet. */
export async function autorizarUsuario(userId: number, rol: Rol, nombre: string): Promise<void> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const existentes = await leerTodos();
  const match = existentes.find((f) => f.usuario.userId === userId);

  if (match) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!B${match.rowIndex}:C${match.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[rol, nombre]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A:D`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[userId, rol, nombre, new Date().toISOString()]] },
    });
  }

  invalidarCacheUsuariosAutorizados();
}

// Acciones (prefijo de callback_data antes de ":") que disparan una escritura
// real (Holded, cashflow, envío de correo, subida a Drive) — solo "admin"
// puede presionarlas. Descartar/cancelar/rechazar/pedir orientación siempre
// queda disponible para cualquier usuario autorizado, porque no escribe nada.
const ACCIONES_SENSIBLES = new Set([
  "cf_approve",
  "recpago_confirmar",
  "draft_enviar",
  "doc_confirm",
  "gasto_adjuntar",
  "gasto_nuevo",
  "evento_confirmar",
  "cerebroacceso_temporal",
  "cerebroacceso_maestro",
  "reportecontable_enviar",
]);

export function esAccionSensible(callbackData: string): boolean {
  const [accion] = callbackData.split(":");
  return ACCIONES_SENSIBLES.has(accion);
}
