import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { conMutex } from "../utils/asyncMutex";
import type { TipoRecurrencia } from "./calendario";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_pagos_recurrentes_pendientes";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días, igual que las propuestas de cashflow

const HEADERS = [
  "id",
  "empresaHolded",
  "concepto",
  "tipo",
  "proveedor",
  "monto",
  "fechaVencimiento",
  "chatId",
  "messageId",
  "creadoEn",
];

export interface PropuestaPagoRecurrente {
  id: string;
  empresaHolded: "WOBA" | "EWORKS" | "Footprint";
  concepto: string;
  tipo: TipoRecurrencia;
  proveedor: string;
  monto: number;
  fechaVencimiento: string; // YYYY-MM-DD
  chatId: number;
  messageId: number;
  creadoEn: number;
}

let writeClient: sheets_v4.Sheets | null = null;
let tabGridId: number | null = null;

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

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
    throw new Error("No se pudo crear la pestaña de pagos recurrentes pendientes.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:J1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToPropuesta(row: unknown[]): PropuestaPagoRecurrente | null {
  if (!row[0]) return null;

  return {
    id: String(row[0]),
    empresaHolded: row[1] as "WOBA" | "EWORKS" | "Footprint",
    concepto: row[2] ? String(row[2]) : "",
    tipo: row[3] as TipoRecurrencia,
    proveedor: row[4] ? String(row[4]) : "",
    monto: Number(row[5]) || 0,
    fechaVencimiento: row[6] ? String(row[6]) : "",
    chatId: Number(row[7]) || 0,
    messageId: Number(row[8]) || 0,
    creadoEn: Number(row[9]) || 0,
  };
}

function propuestaToRow(p: PropuestaPagoRecurrente): (string | number)[] {
  return [
    p.id,
    p.empresaHolded,
    p.concepto,
    p.tipo,
    p.proveedor,
    p.monto,
    p.fechaVencimiento,
    p.chatId,
    p.messageId,
    p.creadoEn,
  ];
}

interface FilaConIndice {
  rowIndex: number;
  propuesta: PropuestaPagoRecurrente;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:J10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];

  rows.forEach((row, i) => {
    const propuesta = rowToPropuesta(row);
    if (propuesta) result.push({ rowIndex: i + 2, propuesta });
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
  const vencidas = todas.filter(({ propuesta }) => ahora - propuesta.creadoEn > TTL_MS);

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

async function siguienteFilaLibre(): Promise<number> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:J`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = resp.data.values ?? [];
  return rows.length + 1;
}

const MAX_INTENTOS_ESCRITURA = 3;

/**
 * Hallazgo real de auditoría (misma noche, mismo bug ya cerrado en
 * gastoProposalSheet.ts/conciliacionPendienteStore.ts para otras dos hojas
 * de este mismo sistema, pero nunca aplicado acá): `values.append` con rango
 * de columnas deja que Sheets ADIVINE la fila/columna real — puede fallar en
 * silencio si el encabezado quedó desactualizado. Y `consumirPropuestaPagoRecurrente`
 * borra filas (desplaza todo hacia arriba) sin ningún lock — un doble-tap del
 * mismo botón de Telegram, o el reintento de un callback_query, puede leer la
 * MISMA propuesta dos veces antes de que la primera eliminación se refleje,
 * dejando pasar DOS pagos recurrentes reales por una sola confirmación. Mismo
 * conMutex y mismo patrón fila-libre-con-verificación ya usados en
 * gastoProposalSheet.ts — se aplica acá por el mismo motivo: proteger la
 * contabilidad de un gasto duplicado.
 */
export async function crearPropuestaPagoRecurrente(
  datos: Omit<PropuestaPagoRecurrente, "id" | "creadoEn">
): Promise<PropuestaPagoRecurrente> {
  return conMutex(TAB_NAME, async () => {
    await purgarVencidas();

    const sheetId = assertSheetId();
    const sheets = getClient();
    await ensureTab();

    const propuesta: PropuestaPagoRecurrente = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

    for (let intento = 0; intento < MAX_INTENTOS_ESCRITURA; intento++) {
      const fila = await siguienteFilaLibre();
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${fila}:J${fila}`,
        valueInputOption: "RAW",
        requestBody: { values: [propuestaToRow(propuesta)] },
      });

      const verificacion = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${fila}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      if (verificacion.data.values?.[0]?.[0] === propuesta.id) return propuesta;

      console.error(
        `[pagoRecurrenteProposalSheet] Colisión al escribir la propuesta ${propuesta.id} en la fila ${fila} (otro proceso escribió ahí primero) — reintento ${intento + 1}/${MAX_INTENTOS_ESCRITURA}.`
      );
    }

    throw new Error(`No se pudo guardar la propuesta ${propuesta.id} tras ${MAX_INTENTOS_ESCRITURA} intentos por colisiones repetidas.`);
  });
}

export async function actualizarMessageIdPagoRecurrente(id: string, messageId: number): Promise<void> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!I${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[messageId]] },
  });
}

/**
 * Devuelve la propuesta y ELIMINA su fila de inmediato (aprobada o
 * descartada). Bajo el mismo conMutex que crearPropuestaPagoRecurrente (ver
 * su comentario) — nunca puede correr a la vez que una escritura esté
 * calculando/usando "la próxima fila libre" de esta misma hoja, y un
 * doble-tap del mismo botón ya no puede leer la misma fila dos veces antes
 * de que la primera eliminación se refleje.
 */
export async function consumirPropuestaPagoRecurrente(id: string): Promise<PropuestaPagoRecurrente | undefined> {
  return conMutex(TAB_NAME, async () => {
    const todas = await leerTodas();
    const match = todas.find(({ propuesta }) => propuesta.id === id);
    if (!match) return undefined;

    await eliminarFila(match.rowIndex);
    return match.propuesta;
  });
}
