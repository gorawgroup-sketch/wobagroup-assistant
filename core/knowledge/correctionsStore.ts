import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_correcciones";
const HEADERS = ["fecha", "contexto_previo", "correccion"];

/**
 * Registro de correcciones ("eso no era así, en realidad...") en una pestaña
 * oculta del Sheet de cashflow — NUNCA en un archivo local: a diferencia de
 * docs/*.md (que va con el código, versionado en git), este contenido se
 * genera en tiempo de ejecución, y el filesystem de Railway no sobrevive a
 * un redeploy. Guardarlo localmente significaría perder cada corrección la
 * próxima vez que se despliegue algo — justo el escenario que este feature
 * existe para evitar.
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

async function ensureTab(): Promise<void> {
  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:C1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
}

export async function registrarCorreccion(datos: { contextoPrevio: string; correccion: string }): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const fecha = new Date().toISOString();

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:C`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[fecha, datos.contextoPrevio, datos.correccion]] },
  });
}

/** Devuelve todas las correcciones registradas, formateadas para incluir como contexto. */
export async function obtenerCorreccionesFormateadas(): Promise<string | null> {
  try {
    await ensureTab();
    const sheetId = assertSheetId();
    const sheets = getClient();

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A2:C10000`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    const filas = resp.data.values ?? [];
    if (filas.length === 0) return null;

    return filas
      .filter((fila) => fila[2])
      .map((fila) => {
        const [fecha, contextoPrevio, correccion] = fila;
        const fechaLabel = fecha ? String(fecha).slice(0, 10) : "";
        const contextoTxt = contextoPrevio ? ` (antes se asumía: ${contextoPrevio})` : "";
        return `- [${fechaLabel}] ${correccion}${contextoTxt}`;
      })
      .join("\n");
  } catch (error) {
    console.error("[knowledge/correctionsStore] Error leyendo correcciones:", error);
    return null;
  }
}
