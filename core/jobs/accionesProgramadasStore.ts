import { google, sheets_v4 } from "googleapis";
import { randomUUID } from "node:crypto";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { crearEventoRecordatorio, eliminarEventoRecordatorio } from "../google/calendarClient";

/**
 * Pedido explícito de Carlos: cuando algo hay que hacerlo más adelante (una
 * fecha futura, o una condición que todavía no se cumple — "hazlo el
 * jueves", "cuando confirmen el pago de X"), Wobi debe programarlo y
 * encargarse sola cuando corresponda, sin dejárselo a él ni volver a
 * preguntar. Este store (Sheets, no un archivo local — Railway es efímero y
 * esto puede quedar pendiente días) es la cola persistente que
 * revisarAccionesProgramadas.ts revisa periódicamente para disparar cada
 * una en su momento.
 */
export type TipoAccionProgramada = "fecha" | "condicion";
export type EstadoAccionProgramada = "pendiente" | "completada" | "cancelada";

export type RecurrenciaAccionProgramada = "mensual";

export interface AccionProgramada {
  id: string;
  chatId: number;
  tipo: TipoAccionProgramada;
  fechaObjetivo?: string; // ISO — solo para tipo="fecha"
  condicion?: string; // texto libre a verificar — solo para tipo="condicion"
  instruccion: string; // autocontenida: lo que hay que hacer, sin depender del contexto de la conversación original
  contexto: string; // de dónde vino (ubicación de la anotación, correo, o "chat directo") — para mostrarlo en avisos
  calendarEventId?: string;
  estado: EstadoAccionProgramada;
  creadoEn: string;
  completadoEn?: string;
  /** Solo para tipo="fecha". Si es "mensual", al dispararse no se marca completada — se reprograma
   *  para el mismo día del mes siguiente (ver reprogramarParaSiguienteOcurrencia). */
  recurrencia?: RecurrenciaAccionProgramada;
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_acciones_programadas";
const HEADERS = [
  "id",
  "chatId",
  "tipo",
  "fechaObjetivo",
  "condicion",
  "instruccion",
  "contexto",
  "calendarEventId",
  "estado",
  "creadoEn",
  "completadoEn",
  "recurrencia",
];

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

interface FilaAccion {
  rowIndex: number;
  accion: AccionProgramada;
}

async function leerTodasLasFilas(): Promise<FilaAccion[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:L10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  return rows
    .filter((row) => row[0])
    .map((row, i) => ({
      rowIndex: i + 2,
      accion: {
        id: String(row[0]),
        chatId: Number(row[1]),
        tipo: (row[2] === "condicion" ? "condicion" : "fecha") as TipoAccionProgramada,
        fechaObjetivo: row[3] ? String(row[3]) : undefined,
        condicion: row[4] ? String(row[4]) : undefined,
        instruccion: String(row[5] || ""),
        contexto: String(row[6] || ""),
        calendarEventId: row[7] ? String(row[7]) : undefined,
        estado: (row[8] === "completada" || row[8] === "cancelada" ? row[8] : "pendiente") as EstadoAccionProgramada,
        creadoEn: String(row[9] || ""),
        completadoEn: row[10] ? String(row[10]) : undefined,
        recurrencia: row[11] === "mensual" ? "mensual" : undefined,
      },
    }));
}

/**
 * Guarda la acción y, si es de tipo "fecha", intenta crear un evento visible
 * en el calendario de Wobi (best-effort — ver calendarClient.ts, nunca
 * bloquea el guardado si Calendar falla).
 */
export async function programarAccion(
  datos: Omit<AccionProgramada, "id" | "calendarEventId" | "estado" | "creadoEn" | "completadoEn">
): Promise<AccionProgramada> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const accion: AccionProgramada = {
    ...datos,
    id: randomUUID().slice(0, 8),
    estado: "pendiente",
    creadoEn: new Date().toISOString(),
  };

  if (accion.tipo === "fecha" && accion.fechaObjetivo) {
    const evento = await crearEventoRecordatorio({
      resumen: `Wobi: ${accion.contexto}`,
      descripcion: accion.instruccion,
      fechaHoraInicioISO: accion.fechaObjetivo,
      invitados: process.env.GOOGLE_IMPERSONATE_EMAIL ? [process.env.GOOGLE_IMPERSONATE_EMAIL] : undefined,
    });
    if (evento) accion.calendarEventId = evento.id;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:L`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          accion.id,
          accion.chatId,
          accion.tipo,
          accion.fechaObjetivo ?? "",
          accion.condicion ?? "",
          accion.instruccion,
          accion.contexto,
          accion.calendarEventId ?? "",
          accion.estado,
          accion.creadoEn,
          "",
          accion.recurrencia ?? "",
        ],
      ],
    },
  });

  return accion;
}

export async function obtenerAccionPorId(id: string): Promise<AccionProgramada | undefined> {
  const todas = await leerTodasLasFilas();
  return todas.find((f) => f.accion.id === id)?.accion;
}

/** Todas las acciones vigentes (estado="pendiente") — para que el job las evalúe una por una. */
export async function obtenerAccionesPendientes(): Promise<AccionProgramada[]> {
  const todas = await leerTodasLasFilas();
  return todas.filter((f) => f.accion.estado === "pendiente").map((f) => f.accion);
}

async function actualizarEstado(id: string, estado: EstadoAccionProgramada): Promise<void> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const todas = await leerTodasLasFilas();
  const fila = todas.find((f) => f.accion.id === id);
  if (!fila) return;

  if (fila.accion.calendarEventId) {
    await eliminarEventoRecordatorio(fila.accion.calendarEventId);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!I${fila.rowIndex}:K${fila.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[estado, fila.accion.creadoEn, new Date().toISOString()]] },
  });
}

export async function marcarAccionCompletada(id: string): Promise<void> {
  await actualizarEstado(id, "completada");
}

export async function marcarAccionCancelada(id: string): Promise<void> {
  await actualizarEstado(id, "cancelada");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Misma fecha/hora, un mes después — respeta el mismo formato "YYYY-MM-DDTHH:mm" que usa el resto
 *  del store (evita que toISOString() introduzca segundos/Z y desalinee el formato guardado). Si el
 *  día no existe en el mes destino (p.ej. 31 en un mes de 30 días), cae en el último día de ese mes. */
function siguienteOcurrenciaMensual(fechaISO: string): string {
  const original = new Date(fechaISO);
  const anioDestino = original.getFullYear() + Math.floor((original.getMonth() + 1) / 12);
  const mesDestino = (original.getMonth() + 1) % 12;
  const ultimoDiaMesDestino = new Date(anioDestino, mesDestino + 1, 0).getDate();
  const diaFinal = Math.min(original.getDate(), ultimoDiaMesDestino);

  const siguiente = new Date(original);
  siguiente.setFullYear(anioDestino, mesDestino, diaFinal);

  return (
    `${siguiente.getFullYear()}-${pad2(siguiente.getMonth() + 1)}-${pad2(siguiente.getDate())}` +
    `T${pad2(siguiente.getHours())}:${pad2(siguiente.getMinutes())}`
  );
}

/**
 * Para acciones con recurrencia="mensual": en vez de marcarla "completada" para siempre (lo que
 * rompería la promesa hecha al usuario de que se avisará cada mes), la reprograma en la MISMA fila
 * para el mismo día del mes siguiente y recrea el evento de calendario. El botón "Cancelar
 * programación" original sigue funcionando para toda la serie, porque el id no cambia.
 * Devuelve undefined si la acción ya no existe o no tiene fechaObjetivo (no debería pasar para
 * tipo="fecha", pero por si acaso el llamador decide qué hacer).
 */
export async function reprogramarParaSiguienteOcurrencia(id: string): Promise<AccionProgramada | undefined> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const todas = await leerTodasLasFilas();
  const fila = todas.find((f) => f.accion.id === id);
  if (!fila || !fila.accion.fechaObjetivo) return undefined;

  if (fila.accion.calendarEventId) {
    await eliminarEventoRecordatorio(fila.accion.calendarEventId);
  }

  const nuevaFecha = siguienteOcurrenciaMensual(fila.accion.fechaObjetivo);
  const evento = await crearEventoRecordatorio({
    resumen: `Wobi: ${fila.accion.contexto}`,
    descripcion: fila.accion.instruccion,
    fechaHoraInicioISO: nuevaFecha,
    invitados: process.env.GOOGLE_IMPERSONATE_EMAIL ? [process.env.GOOGLE_IMPERSONATE_EMAIL] : undefined,
  });
  const nuevoCalendarEventId = evento?.id;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!D${fila.rowIndex}:D${fila.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[nuevaFecha]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!H${fila.rowIndex}:H${fila.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[nuevoCalendarEventId ?? ""]] },
  });

  return { ...fila.accion, fechaObjetivo: nuevaFecha, calendarEventId: nuevoCalendarEventId };
}
