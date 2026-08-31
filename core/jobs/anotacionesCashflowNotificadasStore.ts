import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_anotaciones_cashflow_notificadas";
const HEADERS = ["commentId", "modificado", "notificadoEn"];

/**
 * Registro de qué comentarios del cashflow (ver cashflowComments.ts) ya se
 * avisaron por Telegram — sin esto, revisarAnotacionesCashflow reenviaría
 * el mismo aviso todos los días mientras el comentario siga sin
 * resolverse, a diferencia de las alertas fiscales (que sí repiten porque
 * tienen una ventana de días fija antes del vencimiento). Se guarda
 * también `modificado` (modifiedTime del comentario) para que una EDICIÓN
 * del comentario sí dispare un aviso nuevo, no solo su creación.
 *
 * Pedido explícito de Carlos: cuando una anotación "desaparece del
 * cashflow" (se resuelve o se borra), se elimina también de este registro
 * — no tiene valor de memoria/inteligencia guardarla (a diferencia de, ej.,
 * duplicadosConfirmadosSheet.ts, que SÍ es una base de aprendizaje que se
 * consulta después): esto es solo un registro de deduplicación, purgar lo
 * que ya no es una anotación activa lo mantiene limpio, y si la anotación
 * se reabre más adelante (alguien la marca sin resolver de nuevo), es
 * correcto que se avise otra vez como si fuera nueva. Ver
 * purgarAnotacionesNoActivas.
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
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
  });

  const newSheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId == null) {
    throw new Error("No se pudo crear la pestaña de anotaciones notificadas.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:C1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

interface FilaAnotacionNotificada {
  rowIndex: number; // fila real en la hoja (1-indexado, ya cuenta el header)
  commentId: string;
  modificado: string;
}

async function leerFilas(): Promise<FilaAnotacionNotificada[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:B10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaAnotacionNotificada[] = [];
  rows.forEach((row, i) => {
    if (row[0]) result.push({ rowIndex: i + 2, commentId: String(row[0]), modificado: row[1] ? String(row[1]) : "" });
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

/** Mapa commentId -> modifiedTime ya notificado. */
export async function obtenerAnotacionesYaNotificadas(): Promise<Map<string, string>> {
  const filas = await leerFilas();
  const mapa = new Map<string, string>();
  for (const f of filas) mapa.set(f.commentId, f.modificado);
  return mapa;
}

export async function marcarAnotacionNotificada(commentId: string, modificado: string): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:C`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[commentId, modificado, new Date().toISOString()]] },
  });
}

/**
 * Borra del registro cualquier commentId que ya NO esté en `idsActivos`
 * (el conjunto de anotaciones sin resolver que devolvió la corrida actual
 * de obtenerAnotacionesCashflow) — cubre tanto que el comentario se haya
 * RESUELTO (ya no aparece en esa consulta) como que se haya BORRADO del
 * todo en Sheets (Drive deja de devolverlo). Se llama en cada corrida del
 * job, incluso cuando no hubo anotaciones nuevas que avisar.
 */
export async function purgarAnotacionesNoActivas(idsActivos: Set<string>): Promise<number> {
  const filas = await leerFilas();
  const aBorrar = filas.filter((f) => !idsActivos.has(f.commentId));

  // De abajo hacia arriba para que borrar una fila no corra los índices de las siguientes.
  aBorrar.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const f of aBorrar) {
    await eliminarFila(f.rowIndex);
  }

  return aBorrar.length;
}
