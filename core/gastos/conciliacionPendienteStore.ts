import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import type { Empresa } from "../holded/client";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_conciliaciones_pendientes";
// Bug real encontrado en la auditoría: esto era 3 días, más largo que el
// umbral de 48h con el que revisarCorreoNuevo.ts da por "atascado" y salta
// el correo activo (UMBRAL_ACTIVO_ESTANCADO_MS) — una respuesta tardía a
// "¿conciliar?" (después de esas 48h pero dentro del TTL viejo de 3 días)
// resolvía/avanzaba la cola sobre un correo completamente distinto, el que
// para entonces ya estaba activo. 24h, igual que el resto de los
// "pendiente_*" de la familia, deja margen real de sobra para revisar en
// Holded sin cruzar ese umbral.
const TTL_MS = 24 * 60 * 60 * 1000;

const HEADERS = [
  "id",
  "empresa",
  "monto",
  "fecha",
  "descripcionGasto",
  "chatId",
  "creadoEn",
  "gastoId",
  "moneda",
  "proveedor",
  "deColaCorreo",
  "mensajeIdGmail",
];

/**
 * Cuando se crea un gasto SIN que antes se haya confirmado un movimiento
 * bancario que coincida (ver procesarGastoEntrante.ts), no se concilia
 * automáticamente — se pregunta DESPUÉS de crear, para que Carlos revise el
 * gasto recién creado en Holded antes de decidir. Este store guarda esa
 * pregunta pendiente entre el mensaje "gasto creado" y la respuesta del
 * botón. Sheets, no filesystem local — el filesystem de Railway se borra en
 * cada redeploy (bug real ya encontrado antes con el historial de
 * conversación) y esta espera puede durar más que un par de minutos.
 */
function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

let writeClient: sheets_v4.Sheets | null = null;
let tabAsegurada = false;

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

async function ensureTab(): Promise<void> {
  if (tabAsegurada) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME);
  if (existing) {
    tabAsegurada = true;
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:L1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

export interface ConciliacionPendiente {
  id: string;
  empresa: Empresa;
  monto: number;
  fecha: string;
  descripcionGasto: string;
  chatId: number;
  creadoEn: number;
  /** Id del documento de compra en Holded al que hay que enlazar el movimiento bancario (ver reconciliarMovimiento). */
  gastoId: string;
  /** Moneda en la que se creó el gasto (ej. "EUR", "USD") — determina en qué moneda buscar el movimiento bancario a conciliar. */
  moneda: string;
  /**
   * Nombre del proveedor/contacto — usado como ancla de nombre si el match
   * exacto por monto no encuentra nada y hace falta un fallback aproximado
   * (ver buscarMovimientoAproximado en core/holded/write.ts).
   */
  proveedor: string;
  /** true si el gasto que originó esta pregunta viene de la cola de revisión de correo uno a uno — ver PropuestaGasto.deColaCorreo. */
  deColaCorreo?: boolean;
  /**
   * Id del mensaje de Gmail que originó el gasto — hallazgo real de auditoría: sin esto,
   * vigilarProcesamientoAtascado.ts no tenía forma de saber que un correo "activo" seguía vivo
   * esperando la respuesta de ESTA pregunta (Sí/No conciliar), así que un caso real donde Carlos
   * tardaba más de UMBRAL_ATASCADO_MS en contestar (revisando un lote largo de gastos) hacía que el
   * vigilante lo diera por atascado y forzara un reintento — reprocesando el mismo correo mientras la
   * pregunta original seguía sin responder, generándole una pregunta duplicada de "¿conciliar?" y
   * dejando la primera huérfana. Ver huboSenalDeEntrega en vigilarProcesamientoAtascado.ts.
   */
  mensajeIdGmail?: string;
}

interface FilaConIndice {
  rowIndex: number;
  pendiente: ConciliacionPendiente;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:L10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    if (!row[0]) return;
    result.push({
      rowIndex: i + 2,
      pendiente: {
        id: String(row[0]),
        empresa: row[1] as Empresa,
        monto: Number(row[2]) || 0,
        fecha: row[3] ? String(row[3]) : "",
        descripcionGasto: row[4] ? String(row[4]) : "",
        chatId: Number(row[5]) || 0,
        creadoEn: Number(row[6]) || 0,
        gastoId: row[7] ? String(row[7]) : "",
        moneda: row[8] ? String(row[8]) : "EUR",
        proveedor: row[9] ? String(row[9]) : "",
        deColaCorreo: row[10] === true || row[10] === "true",
        mensajeIdGmail: row[11] ? String(row[11]) : undefined,
      },
    });
  });
  return result;
}

async function eliminarFila(rowIndex1Based: number): Promise<void> {
  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const gridId = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME)?.properties?.sheetId;
  if (gridId == null) return;

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
  const vencidas = todas.filter(({ pendiente }) => ahora - pendiente.creadoEn > TTL_MS);
  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) await eliminarFila(rowIndex);
}

/**
 * Nunca usar values.append con un rango de columnas (ver el mismo hallazgo, mucho más grave, en
 * crearPropuestaGasto de gastoProposalSheet.ts): la fila de encabezados de este tab quedó
 * desactualizada (7 columnas reales contra las 12 que ya tiene ConciliacionPendiente), y esa forma
 * irregular puede hacer que Sheets adivine mal en qué columna empieza la fila nueva — la fila se
 * escribe completa, sin ningún error, pero termina invisible para cualquier lectura posterior. Se
 * calcula la fila libre a mano y se escribe con un rango explícito, igual que allá.
 */
async function siguienteFilaLibre(): Promise<number> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:L`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = resp.data.values ?? [];
  return rows.length + 1;
}

const MAX_INTENTOS_ESCRITURA = 3;

/** Ver crearPropuestaGasto en gastoProposalSheet.ts — misma protección contra colisión: dos llamadas
 * casi simultáneas podrían calcular la misma fila libre y que la segunda pise a la primera. Tras
 * escribir se relee esa fila y se confirma el id; si no coincide, se reintenta en una fila nueva. */
export async function guardarConciliacionPendiente(
  datos: Omit<ConciliacionPendiente, "id" | "creadoEn">
): Promise<ConciliacionPendiente> {
  await purgarVencidas();
  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  const pendiente: ConciliacionPendiente = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  const fila_valores = [
    pendiente.id,
    pendiente.empresa,
    pendiente.monto,
    pendiente.fecha,
    pendiente.descripcionGasto,
    pendiente.chatId,
    pendiente.creadoEn,
    pendiente.gastoId,
    pendiente.moneda,
    pendiente.proveedor,
    pendiente.deColaCorreo === true ? "true" : "",
    pendiente.mensajeIdGmail ?? "",
  ];

  for (let intento = 0; intento < MAX_INTENTOS_ESCRITURA; intento++) {
    const fila = await siguienteFilaLibre();
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A${fila}:L${fila}`,
      valueInputOption: "RAW",
      requestBody: { values: [fila_valores] },
    });

    const verificacion = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A${fila}`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    if (verificacion.data.values?.[0]?.[0] === pendiente.id) return pendiente;

    console.error(
      `[conciliacionPendienteStore] Colisión al escribir la pendiente ${pendiente.id} en la fila ${fila} — reintento ${intento + 1}/${MAX_INTENTOS_ESCRITURA}.`
    );
  }

  throw new Error(`No se pudo guardar la conciliación pendiente ${pendiente.id} tras ${MAX_INTENTOS_ESCRITURA} intentos por colisiones repetidas.`);
}

/** Todas las conciliaciones pendientes de un chat — usado por vigilarProcesamientoAtascado.ts para saber si un correo "activo" sigue vivo esperando esta pregunta, en vez de darlo por atascado. */
export async function obtenerConciliacionesPendientesPorChat(chatId: number): Promise<ConciliacionPendiente[]> {
  const todas = await leerTodas();
  return todas.filter(({ pendiente }) => pendiente.chatId === chatId).map(({ pendiente }) => pendiente);
}

/** Devuelve la pendiente y ELIMINA su fila (respondida, ya no debe quedar registro). */
export async function consumirConciliacionPendiente(id: string): Promise<ConciliacionPendiente | undefined> {
  const todas = await leerTodas();
  const match = todas.find(({ pendiente }) => pendiente.id === id);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.pendiente;
}
