import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { registrarPersonaDesdeTelegram } from "../directorio/directorioPersonasSheet";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_usuarios_autorizados";
const HEADERS = ["userId", "rol", "nombre", "autorizadoEn"];

// "superadmin" es un rol nuevo, deliberadamente distinto de "admin": desde
// que se creó, TODAS las acciones de escritura del sistema (Holded,
// cashflow, eventos CRM, accesos a /cerebro, reportes por correo) y TODAS
// las decisiones sobre correo entrante (proceder/descartar/dar
// instrucciones/enviar respuesta) requieren superadmin específicamente —
// "admin" por sí solo ya NO alcanza para ninguna de ellas (ver
// ACCIONES_SENSIBLES y esAccionSensible más abajo). Pedido explícito:
// centralizar esas decisiones en una sola persona (Carlos).
export type Rol = "superadmin" | "admin" | "colaborador";

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
  const rolCrudo = row[1];
  const rol: Rol = rolCrudo === "superadmin" ? "superadmin" : rolCrudo === "admin" ? "admin" : "colaborador";
  return {
    userId: Number(row[0]),
    rol,
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

/** "admin" en el sentido amplio (recibe notificaciones/resúmenes de admin) — incluye superadmin, que es un superconjunto. */
export async function obtenerAdmins(): Promise<UsuarioAutorizado[]> {
  const usuarios = await obtenerUsuariosAutorizados();
  return usuarios.filter((u) => u.rol === "admin" || u.rol === "superadmin");
}

/** Autoriza (o actualiza el rol/nombre de) un usuario — ver eliminarUsuario más abajo para quitar acceso. */
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

  // No crítico — si falla el directorio, la autorización en sí ya quedó
  // guardada arriba, así que no se debe tumbar todo el flujo por esto.
  registrarPersonaDesdeTelegram(nombre, userId).catch((error) =>
    console.error("[authorizedUsersSheet] Error registrando en el directorio de personas:", error)
  );
}

/**
 * Quita el acceso de un usuario (borra la fila) — usado desde el panel de
 * administración de /cerebro (solo con la key maestra, ver
 * exigeKeyMaestra en server.ts). Antes esto se hacía a mano directo en el
 * Sheet; ahora hay una vía real desde la interfaz. Devuelve false si el
 * usuario no existía (nada que borrar), sin lanzar error.
 */
export async function eliminarUsuario(userId: number): Promise<boolean> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const existentes = await leerTodos();
  const match = existentes.find((f) => f.usuario.userId === userId);
  if (!match) return false;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const gridId = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME)?.properties?.sheetId;
  if (gridId == null) return false;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId: gridId, dimension: "ROWS", startIndex: match.rowIndex - 1, endIndex: match.rowIndex },
          },
        },
      ],
    },
  });

  invalidarCacheUsuariosAutorizados();
  return true;
}

// Acciones (prefijo de callback_data antes de ":") que disparan una
// escritura real (Holded, cashflow, subida a Drive) o una decisión sobre
// correo entrante — TODAS requieren "superadmin" específicamente (ver
// puedeAprobarAccionSensible más abajo). Las de correo (email_proceder,
// email_descartar, email_orientar) se agregaron a propósito aunque
// descartar/orientar no escriban nada: el pedido fue centralizar en
// superadmin la decisión completa sobre un correo entrante, no solo el
// envío final.
const ACCIONES_SENSIBLES = new Set([
  "cf_approve",
  "recpago_confirmar",
  "draft_enviar",
  "doc_confirm",
  "gasto_adjuntar",
  "gasto_nuevo",
  "gasto_usarcontacto",
  "gasto_crearsinproveedor",
  "evento_confirmar",
  "cerebroacceso_temporal",
  "cerebroacceso_maestro",
  "reportecontable_enviar",
  "email_proceder",
  "email_descartar",
  "email_orientar",
  // Mismo criterio: "Guardar como conocimiento" es una de las 4 decisiones
  // posibles sobre un correo entrante (junto a proceder/descartar/dar
  // instrucciones) — ver core/jobs/revisarCorreoNuevo.ts.
  "email_guardar",
  // Mismo criterio que las decisiones sobre correo entrante (arriba) —
  // "Hazlo tú" investiga y actúa, "Dar instrucciones" y "Dejar como
  // informativo" son decisiones sobre esa acción — encontrado como gap
  // real en auditoría (2026-09-02): estas tres se agregaron el mismo día
  // que las decisiones de correo, pero quedaron fuera de este set por
  // descuido, así que cualquier usuario autorizado (no solo superadmin)
  // podía disparar una investigación/escritura real sobre el cashflow.
  "anotcf_proceder",
  "anotcf_orientar",
  "anotcf_descartar",
  // Cancelar una acción YA programada es también una decisión de negocio
  // (pudo haberse programado algo con efecto financiero) — mismo criterio
  // que email_descartar.
  "accprog_cancelar",
  // Gap real encontrado en auditoría (2026-09-02): estas tres se agregaron
  // el mismo día que "Enseñar regla"/"Crear alerta"/"Guardar como
  // conocimiento" para documentos, pero quedaron fuera de este set —
  // "doc_regla" y "doc_alerta" escriben estado persistente (una regla de
  // clasificación automática, una acción programada), y "doc_conocimiento"
  // dispara el flujo de captura — mismo criterio que "doc_confirm", que sí
  // estaba protegido.
  "doc_regla",
  "doc_alerta",
  "doc_conocimiento",
  // Mismo criterio que email_descartar/anotcf_descartar: "❌ Descartar" es
  // una de las decisiones posibles sobre un documento entrante (junto a
  // archivar/reclasificar/guardar como conocimiento) — se centraliza en
  // superadmin igual que las demás, no solo la que escribe en Drive.
  "doc_descartar",
  "desamb_descartar",
  // Mismo criterio que el resto de decisiones sobre la cola de revisión de
  // correo (email_proceder/descartar) — avanzar a mostrar el siguiente
  // correo, o descartar el que está bloqueando, son parte de esa misma
  // decisión centralizada en superadmin.
  "colacorreo_siguiente",
  "colacorreo_descartaractivo",
  "resumen_descartar_todo",
  // Gap real encontrado en la auditoría del 2026-09-03: "¿Quieres
  // conciliar?" (preguntarSiConciliar en gastoCallbackHandler.ts) se agregó
  // el mismo día que se corrigió cuándo avanza la cola, pero quedó fuera de
  // este set — cualquier usuario autorizado (no solo superadmin) podía
  // confirmar una conciliación real en Holded. Mismo criterio que
  // email_descartar/anotcf_descartar: se protegen las dos opciones (sí y
  // no), no solo la que escribe, para centralizar la decisión completa.
  "gasto_conciliar_si",
  "gasto_conciliar_no",
  // Mismo criterio que email_guardar/email_orientar: responder el correo,
  // guardarlo como conocimiento, o dar instrucciones adicionales (recordatorio,
  // etc.) sobre el correo de origen de una propuesta de gasto son también
  // decisiones sobre ese correo entrante — se centralizan en superadmin igual
  // que las demás, no solo el registro del gasto en sí (gasto_nuevo).
  "gasto_responder",
  "gasto_guardarconocimiento",
  "gasto_otrasacciones",
]);

export function esAccionSensible(callbackData: string): boolean {
  const [accion] = callbackData.split(":");
  return ACCIONES_SENSIBLES.has(accion);
}

/** Las acciones sensibles requieren superadmin específicamente — "admin" ya no alcanza. */
export function puedeAprobarAccionSensible(rol: Rol | undefined): boolean {
  return rol === "superadmin";
}
