import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import type { IdentidadCorreoCola } from "./colaRevisionStore";
import { conMutex } from "../utils/asyncMutex";

export interface BorradorCorreo {
  id: string;
  chatId: number;
  messageId: number;
  to: string;
  subject: string;
  threadId?: string;
  messageIdHeader?: string;
  cuerpo: string;
  creadoEn: number;
  /** Este borrador es la decisión todavía pendiente del correo de la cola. */
  deColaCorreo?: boolean;
  correoThreadId?: string;
  correoMensajeId?: string;
  /** Acción durable que reservó y transfirió esta unidad concreta de cola. */
  unidadColaId?: string;
}

export interface CorrelacionBorradorCorreo {
  threadId?: string;
  messageIdHeader?: string;
  to?: string;
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_borradores_correo";
// Bug real encontrado en vivo (mismo patrón que classificationStore.ts y
// disambiguationStore.ts): este store vivía en un archivo JSON local, que
// se pierde en cada redeploy de Railway — un borrador de correo pendiente
// de aprobación podía desaparecer en silencio a mitad de una sesión de
// desarrollo activa. Migrado a Sheets, mismo patrón que el resto del
// proyecto.
const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas, igual que antes
const MUTEX_BORRADORES = "emailDraftStore:transiciones";

const HEADERS = [
  "id",
  "chatId",
  "messageId",
  "to",
  "subject",
  "threadId",
  "messageIdHeader",
  "cuerpo",
  "creadoEn",
  "deColaCorreo",
  "correoThreadId",
  "correoMensajeId",
  "unidadColaId",
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
    // La pestaña precede a los campos de identidad de cola; extender la fila
    // de headers es una migración aditiva e idempotente.
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
    throw new Error("No se pudo crear la pestaña de borradores de correo.");
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

function rowToBorrador(row: unknown[]): BorradorCorreo | null {
  if (!row[0]) return null;
  return {
    id: String(row[0]),
    chatId: Number(row[1]) || 0,
    messageId: Number(row[2]) || 0,
    to: row[3] ? String(row[3]) : "",
    subject: row[4] ? String(row[4]) : "",
    threadId: row[5] ? String(row[5]) : undefined,
    messageIdHeader: row[6] ? String(row[6]) : undefined,
    cuerpo: row[7] ? String(row[7]) : "",
    creadoEn: Number(row[8]) || 0,
    deColaCorreo: String(row[9] ?? "") === "true",
    correoThreadId: row[10] ? String(row[10]) : undefined,
    correoMensajeId: row[11] ? String(row[11]) : undefined,
    unidadColaId: row[12] ? String(row[12]) : undefined,
  };
}

function borradorToRow(b: BorradorCorreo): (string | number)[] {
  return [
    b.id,
    b.chatId,
    b.messageId,
    b.to,
    b.subject,
    b.threadId ?? "",
    b.messageIdHeader ?? "",
    b.cuerpo,
    b.creadoEn,
    b.deColaCorreo ? "true" : "",
    b.correoThreadId ?? "",
    b.correoMensajeId ?? "",
    b.unidadColaId ?? "",
  ];
}

export interface FilaBorradorConIndice {
  rowIndex: number;
  borrador: BorradorCorreo;
}

async function leerTodos(): Promise<FilaBorradorConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:M10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaBorradorConIndice[] = [];
  rows.forEach((row, i) => {
    const borrador = rowToBorrador(row);
    if (borrador) result.push({ rowIndex: i + 2, borrador });
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

async function purgarVencidosSinMutex(): Promise<void> {
  const todos = await leerTodos();
  const ahora = Date.now();
  // Un borrador que posee una unidad de la cola mantiene el correo UNREAD
  // hasta Enviar/Cancelar. Borrarlo por tiempo dejaría el activo sin botón
  // ni dueño del contador. Esos borradores solo terminan por acción explícita
  // (o por la recuperación del estado durable de Gmail), nunca por TTL.
  const vencidos = todos.filter(({ borrador }) =>
    !borrador.deColaCorreo && ahora - borrador.creadoEn > TTL_MS
  );

  vencidos.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidos) {
    await eliminarFila(rowIndex);
  }
}

export async function crearBorradorCorreo(
  datos: Omit<BorradorCorreo, "id" | "creadoEn">
): Promise<BorradorCorreo> {
  return conMutex(MUTEX_BORRADORES, async () => {
    await purgarVencidosSinMutex();

    if (datos.deColaCorreo && (!datos.correoThreadId?.trim() || !datos.correoMensajeId?.trim())) {
      throw new Error("Un borrador de la cola requiere threadId y mensajeId de Gmail.");
    }

    const sheetId = assertSheetId();
    const sheets = getClient();
    await ensureTab();

    const borrador: BorradorCorreo = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A:M`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [borradorToRow(borrador)] },
    });

    return borrador;
  });
}

export async function actualizarMessageIdBorrador(id: string, messageId: number): Promise<void> {
  await conMutex(MUTEX_BORRADORES, async () => {
    const todos = await leerTodos();
    const match = todos.find(({ borrador }) => borrador.id === id);
    if (!match) return;

    await getClient().spreadsheets.values.update({
      spreadsheetId: assertSheetId(),
      range: `${TAB_NAME}!C${match.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[messageId]] },
    });
  });
}

export async function actualizarCuerpoBorrador(id: string, cuerpo: string): Promise<BorradorCorreo | undefined> {
  return conMutex(MUTEX_BORRADORES, async () => {
    const todos = await leerTodos();
    const match = todos.find(({ borrador }) => borrador.id === id);
    if (!match) return undefined;

    await getClient().spreadsheets.values.update({
      spreadsheetId: assertSheetId(),
      range: `${TAB_NAME}!H${match.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[cuerpo]] },
    });

    return { ...match.borrador, cuerpo };
  });
}

/**
 * Cuenta los borradores pendientes de aprobación (solo lectura, para
 * diagnóstico/dashboard).
 */
export async function contarBorradoresPendientes(): Promise<number> {
  return conMutex(MUTEX_BORRADORES, async () => {
    await purgarVencidosSinMutex();
    const todos = await leerTodos();
    return todos.length;
  });
}

export async function obtenerBorradorCorreo(id: string): Promise<BorradorCorreo | undefined> {
  const todos = await leerTodos();
  return todos.find(({ borrador }) => borrador.id === id)?.borrador;
}

/** Devuelve todos los borradores del chat. El watchdog filtra después por
 * `deColaCorreo` y por ambos ids de Gmail; nunca toma un borrador manual como
 * evidencia de que el correo activo ya mostró una decisión. */
export async function obtenerBorradoresCorreoPorChat(chatId: number): Promise<BorradorCorreo[]> {
  const todos = await leerTodos();
  return todos
    .filter(({ borrador }) => borrador.chatId === chatId && borrador.messageId > 0)
    .map(({ borrador }) => borrador);
}

/**
 * Bug real encontrado en vivo (2026-09-08): continuarConOrientacion (emailCallbackHandler.ts) llama a
 * askClaude con la instrucción libre de Carlos y LUEGO, con un regex ("¿la instrucción menciona
 * 'correo'/'responder'/...?") sobre el TEXTO de esa instrucción, decide si además genera un segundo
 * borrador aparte (generarBorradorYOfrecer) — sin fijarse en si askClaude ya resolvió el pedido usando
 * la tool proponer_envio_correo (que escribe en este mismo store). Caso real: "envío correo a
 * Alberto..." SÍ contiene la palabra "correo", así que el regex disparaba el segundo borrador SIEMPRE,
 * aunque el primero (el real, ya mostrado con sus propios botones) ya hubiera cumplido el pedido —
 * Carlos terminó con dos borradores distintos y contradictorios para la misma instrucción. Esta
 * función le da a ese chequeo una señal real en vez de adivinar por texto: ¿ya se creó un borrador
 * para este chat desde que empezó a procesarse la instrucción?
 */
export async function huboBorradorCreadoDesde(chatId: number, desdeMs: number): Promise<boolean> {
  const todos = await leerTodos();
  return todos.some(({ borrador }) => borrador.chatId === chatId && borrador.creadoEn >= desdeMs);
}

export function seleccionarBorradorCorrelacionado(
  candidatos: readonly BorradorCorreo[],
  correlacion?: CorrelacionBorradorCorreo
): BorradorCorreo | undefined {
  if (candidatos.length === 0) return undefined;

  const threadId = correlacion?.threadId?.trim() || undefined;
  const messageIdHeader = correlacion?.messageIdHeader?.trim() || undefined;
  const to = correlacion?.to?.trim().toLowerCase() || undefined;
  if (threadId || messageIdHeader || to) {
    const correlacionados = candidatos.filter((borrador) =>
      (!threadId || borrador.threadId === threadId) &&
      (!messageIdHeader || borrador.messageIdHeader === messageIdHeader) &&
      (!to || borrador.to.trim().toLowerCase() === to)
    );
    if (correlacionados.length === 1) return correlacionados[0];
    if (correlacionados.length === 0) {
      throw new Error("Se creó un borrador durante la ejecución, pero no corresponde al correo original.");
    }
    throw new Error("Se crearon varios borradores que coinciden con el mismo correo; requieren revisión individual.");
  }

  if (candidatos.length > 1) {
    throw new Error("Se crearon varios borradores durante la misma ejecución; no se puede elegir uno de forma segura.");
  }
  return candidatos[0];
}

/** Devuelve el borrador más reciente creado por una ejecución concreta. */
export async function obtenerBorradorCreadoDesde(
  chatId: number,
  desdeMs: number,
  correlacion?: CorrelacionBorradorCorreo
): Promise<BorradorCorreo | undefined> {
  const todos = await leerTodos();
  const candidatos = todos
    .map(({ borrador }) => borrador)
    .filter((borrador) => borrador.chatId === chatId && borrador.creadoEn >= desdeMs && borrador.messageId > 0)
    .sort((a, b) => b.creadoEn - a.creadoEn);
  return seleccionarBorradorCorrelacionado(candidatos, correlacion);
}

/**
 * Transfiere al borrador la responsabilidad de cerrar el correo. Mientras
 * los botones Enviar/Editar/Cancelar sigan pendientes, la cola no avanza.
 */
export async function vincularBorradorACola(
  id: string,
  identidad: IdentidadCorreoCola,
  unidadColaId?: string
): Promise<BorradorCorreo | undefined> {
  return conMutex(MUTEX_BORRADORES, async () => {
    const todos = await leerTodos();
    const match = todos.find(({ borrador }) => borrador.id === id);
    if (!match) return undefined;
    const correoThreadId = identidad.threadId?.trim() || undefined;
    const correoMensajeId = identidad.mensajeId?.trim() || undefined;
    if (!correoThreadId || !correoMensajeId) return undefined;
    const unidadColaIdFinal = unidadColaId?.trim() || match.borrador.unidadColaId;

    const sheets = getClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: assertSheetId(),
      range: `${TAB_NAME}!J${match.rowIndex}:M${match.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [["true", correoThreadId ?? "", correoMensajeId ?? "", unidadColaIdFinal ?? ""]] },
    });
    const verificacion = await sheets.spreadsheets.values.get({
      spreadsheetId: assertSheetId(),
      range: `${TAB_NAME}!A${match.rowIndex}:M${match.rowIndex}`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const verificado = rowToBorrador(verificacion.data.values?.[0] ?? []);
    if (!verificado || verificado.id !== id || !verificado.deColaCorreo ||
        verificado.correoThreadId !== correoThreadId || verificado.correoMensajeId !== correoMensajeId ||
        verificado.unidadColaId !== unidadColaIdFinal) {
      throw new Error("La identidad del borrador no quedó verificada en Sheets.");
    }
    return verificado;
  });
}

export interface DependenciasConsumoBorrador {
  leer: () => Promise<FilaBorradorConIndice[]>;
  eliminar: (rowIndex: number) => Promise<void>;
}

/** Primitivo probado que hace atómico el read→delete dentro del proceso. */
export async function consumirBorradorUnaVez(
  id: string,
  dependencias: DependenciasConsumoBorrador = { leer: leerTodos, eliminar: eliminarFila },
  claveMutex = MUTEX_BORRADORES
): Promise<BorradorCorreo | undefined> {
  return conMutex(claveMutex, async () => {
    const todos = await dependencias.leer();
    const match = todos.find(({ borrador }) => borrador.id === id);
    if (!match) return undefined;

    await dependencias.eliminar(match.rowIndex);
    return match.borrador;
  });
}

/** Devuelve el borrador y lo elimina (se llama al enviar o cancelar). */
export async function consumirBorradorCorreo(id: string): Promise<BorradorCorreo | undefined> {
  return consumirBorradorUnaVez(id);
}
