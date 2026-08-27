import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_directorio_personas";
const HEADERS = ["nombre", "email", "origen", "primeraVez", "ultimaVez", "vecesVisto"];

/**
 * Directorio de personas que el sistema va reconociendo solo, sin que nadie
 * lo cargue a mano — se alimenta de dos fuentes:
 * 1. Quién se autoriza para usar el asistente por Telegram (autorizarUsuario
 *    en authorizedUsersSheet.ts llama a registrarPersonaDesdeTelegram).
 * 2. Con quién se cruza correo, tanto entrante (revisarCorreoNuevo.ts, el
 *    remitente de cada correo revisado) como saliente (enviarCorreo en
 *    gmail/client.ts, el destinatario de cada correo real que se manda).
 * Vive en una pestaña oculta del mismo Sheet de cashflow — mismo patrón que
 * el resto de los stores de este proyecto (nunca en disco local).
 */
function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

let writeClient: sheets_v4.Sheets | null = null;

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

let tabAsegurada = false;

async function ensureTab(): Promise<void> {
  if (tabAsegurada) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME);

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:F1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

export interface PersonaDirectorio {
  rowIndex: number;
  nombre: string;
  email: string;
  origen: string;
  primeraVez: string;
  ultimaVez: string;
  vecesVisto: number;
}

async function leerTodas(): Promise<PersonaDirectorio[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:F10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const filas = resp.data.values ?? [];
  return filas
    .map((f, i) => ({
      rowIndex: i + 2,
      nombre: f[0] ? String(f[0]) : "",
      email: f[1] ? String(f[1]) : "",
      origen: f[2] ? String(f[2]) : "",
      primeraVez: f[3] ? String(f[3]) : "",
      ultimaVez: f[4] ? String(f[4]) : "",
      vecesVisto: Number(f[5]) || 0,
    }))
    .filter((p) => p.nombre || p.email);
}

/** Clave de deduplicación: el email en minúsculas si hay, si no "telegram:<userId>" o el nombre tal cual. */
function claveDePersona(p: { email?: string; claveAlterna?: string }): string {
  if (p.email) return p.email.toLowerCase();
  return (p.claveAlterna ?? "").toLowerCase();
}

async function upsert(params: { nombre: string; email?: string; origen: string; claveAlterna?: string }): Promise<void> {
  const nombre = params.nombre.trim();
  const email = params.email?.trim().toLowerCase() ?? "";
  if (!nombre && !email) return;

  const sheetId = assertSheetId();
  const sheets = getClient();
  const existentes = await leerTodas();

  const clave = claveDePersona({ email, claveAlterna: params.claveAlterna });
  const match = existentes.find((p) => claveDePersona({ email: p.email, claveAlterna: p.email ? undefined : p.nombre }) === clave);

  const ahora = new Date().toISOString();

  if (match) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A${match.rowIndex}:F${match.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[nombre || match.nombre, email || match.email, params.origen, match.primeraVez || ahora, ahora, match.vecesVisto + 1]],
      },
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:F`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[nombre, email, params.origen, ahora, ahora, 1]] },
  });
}

/** Registra (o actualiza la última vez visto) a alguien que se autorizó para usar el asistente por Telegram. */
export async function registrarPersonaDesdeTelegram(nombre: string, userId: number): Promise<void> {
  if (!nombre.trim()) return;
  try {
    await upsert({ nombre, origen: "telegram", claveAlterna: `telegram:${userId}` });
  } catch (error) {
    console.error("[directorioPersonasSheet] Error registrando persona desde Telegram (no crítico):", error);
  }
}

/** Parsea un header "Nombre Apellido <email@dominio.com>" (o solo el email) en {nombre, email}. */
export function parsearRemitente(headerDe: string): { nombre: string; email: string } {
  const match = headerDe.match(/^(.*?)<([^<>]+)>\s*$/);
  if (match) {
    const nombre = match[1].trim().replace(/^["']|["']$/g, "");
    return { nombre, email: match[2].trim() };
  }
  const soloEmail = headerDe.trim();
  return { nombre: "", email: /@/.test(soloEmail) ? soloEmail : "" };
}

/** Registra (o actualiza) a alguien con quien se cruzó correo — entrante o saliente. */
export async function registrarPersonaDesdeCorreo(headerConNombreYEmail: string, origen: "correo_entrante" | "correo_saliente"): Promise<void> {
  const { nombre, email } = parsearRemitente(headerConNombreYEmail);
  if (!email) return;
  try {
    await upsert({ nombre, email, origen });
  } catch (error) {
    console.error("[directorioPersonasSheet] Error registrando persona desde correo (no crítico):", error);
  }
}

/** Busca personas cuyo nombre o email contenga la consulta (insensible a mayúsculas/acentos simples). */
export async function buscarPersonas(consulta: string): Promise<PersonaDirectorio[]> {
  const q = consulta.trim().toLowerCase();
  if (!q) return [];
  const todas = await leerTodas();
  return todas.filter((p) => p.nombre.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
}

export async function listarPersonas(): Promise<PersonaDirectorio[]> {
  return leerTodas();
}
