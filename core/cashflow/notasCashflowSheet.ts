import { google, sheets_v4 } from "googleapis";
import { randomUUID } from "node:crypto";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_notas_cashflow";
const HEADERS = ["id", "concepto", "valor", "empresa", "nota", "autor", "creadoEn"];

/**
 * Notas/observaciones ligadas a un gasto o ingreso ESPECÍFICO del cashflow
 * (identificado por concepto + monto, ej. "Robar — 1076.90") — a diferencia
 * de CAPTURA (conocimiento general suelto), esto se busca puntualmente
 * cuando alguien pregunta por ese gasto/ingreso en particular (ver
 * core/tools/notasCashflow.ts). Se guarda directo, sin botón de aprobación
 * — es una observación/instrucción informativa, no una escritura financiera
 * real, mismo criterio que registrar_correccion.
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
    range: `${TAB_NAME}!A1:G1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

export interface NotaCashflow {
  id: string;
  concepto: string;
  valor: number;
  empresa: string;
  nota: string;
  autor: string;
  creadoEn: string;
}

/** Guarda una nota nueva. Deja que cualquier error de la API se propague — nunca confirma un guardado que no ocurrió. */
export async function guardarNotaCashflow(params: {
  concepto: string;
  valor: number;
  empresa?: string;
  nota: string;
  autor?: string;
}): Promise<NotaCashflow> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const registro: NotaCashflow = {
    id: randomUUID(),
    concepto: params.concepto.trim(),
    valor: Math.round(Math.abs(params.valor) * 100) / 100,
    empresa: params.empresa ?? "",
    nota: params.nota.trim(),
    autor: params.autor ?? "",
    creadoEn: new Date().toISOString(),
  };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:G`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[registro.id, registro.concepto, registro.valor, registro.empresa, registro.nota, registro.autor, registro.creadoEn]],
    },
  });

  return registro;
}

async function leerTodas(): Promise<NotaCashflow[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:G10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const filas = resp.data.values ?? [];
  return filas
    .filter((f) => f[0])
    .map((f) => ({
      id: String(f[0]),
      concepto: f[1] ? String(f[1]) : "",
      valor: Number(f[2]) || 0,
      empresa: f[3] ? String(f[3]) : "",
      nota: f[4] ? String(f[4]) : "",
      autor: f[5] ? String(f[5]) : "",
      creadoEn: f[6] ? String(f[6]) : "",
    }));
}

const TOLERANCIA_VALOR = 0.01;

/**
 * Busca notas por concepto (substring, sin distinguir mayúsculas/acentos
 * simples) y/o por monto (tolerancia de 1 céntimo) — con cualquiera de los
 * dos criterios presentes ya filtra; si se dan ambos, deben coincidir los dos.
 */
export async function buscarNotasCashflow(query: { concepto?: string; valor?: number }): Promise<NotaCashflow[]> {
  const todas = await leerTodas();
  const conceptoQ = query.concepto?.trim().toLowerCase();

  return todas.filter((n) => {
    const matchConcepto = conceptoQ ? n.concepto.toLowerCase().includes(conceptoQ) : true;
    const matchValor = query.valor !== undefined ? Math.abs(n.valor - Math.abs(query.valor)) <= TOLERANCIA_VALOR : true;
    return matchConcepto && matchValor;
  });
}

export async function listarNotasCashflow(): Promise<NotaCashflow[]> {
  return leerTodas();
}
