import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_capturas";
const HEADERS = ["fecha", "autor", "texto", "empresas"];

/**
 * Conocimiento capturado por el equipo (mensajes con la palabra CAPTURA), en
 * una pestaña oculta del Sheet de cashflow — NUNCA en un archivo local
 * (docs/conocimiento_capturado.md, ya retirado). Mismo motivo que
 * correctionsStore.ts: este contenido se genera en tiempo de ejecución, y el
 * filesystem de Railway no sobrevive a un redeploy — guardarlo en disco
 * significa perderlo en el próximo deploy, justo lo que este store existe
 * para evitar. Se migró aquí el 2026-08-26 tras confirmar (vía el endpoint
 * de diagnóstico /admin/conocimiento-capturado) que el archivo local en
 * producción ya estaba vacío — no había nada que migrar, solo el riesgo de
 * que la próxima captura se perdiera.
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

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }],
      },
    });
  }

  // Siempre reescribe la fila de headers (idempotente, contenido fijo) — así
  // una pestaña creada antes de agregar la columna "empresas" (2026-08-27)
  // queda migrada sola en el siguiente registro, sin script aparte.
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:D1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
}

/**
 * Guarda el mensaje completo tal cual, sin paso de revisión ni aprobación —
 * si se captura, se asume ya validado por quien la mandó. Funciona sin
 * importar quién escriba (no valida remitente ni rol).
 */
export async function registrarCaptura(textoCompleto: string, autor?: string, empresas?: string[]): Promise<void> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const fecha = new Date().toISOString();

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:D`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[fecha, autor ?? "", textoCompleto.trim(), (empresas ?? []).join(", ")]] },
  });
}

/**
 * Devuelve todas las capturas registradas, formateadas para incluir como
 * contexto. Cada captura se renderiza como un bloque delimitado (encabezado
 * + texto tal cual, sin aplanarlo en una sola línea con guion) — un mensaje
 * capturado de varios items (ej. varias plataformas con su propio "lo cargan
 * el día X") suele traer sus propios saltos de línea y guiones internos; con
 * un solo "- [...] texto" quedaba todo pegado y era fácil que el modelo
 * mezclara o se saltara datos de un item al leerlo. El separador "---" entre
 * capturas y el encabezado con la(s) empresa(s) ayudan a que cada bloque se
 * lea como una unidad aparte.
 */
export async function obtenerCapturasFormateadas(): Promise<string | null> {
  try {
    await ensureTab();
    const sheetId = assertSheetId();
    const sheets = getClient();

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${TAB_NAME}!A2:D10000`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    const filas = resp.data.values ?? [];
    if (filas.length === 0) return null;

    return filas
      .filter((fila) => fila[2])
      .map((fila) => {
        const [fecha, autor, texto, empresas] = fila;
        const fechaLabel = fecha ? String(fecha).slice(0, 10) : "";
        const autorLabel = autor ? ` — ${autor}` : "";
        const empresasLabel = empresas ? ` — Empresa(s): ${empresas}` : " — Empresa(s): sin especificar";
        return `### Captura del ${fechaLabel}${empresasLabel}${autorLabel}\n${texto}`;
      })
      .join("\n\n---\n\n");
  } catch (error) {
    console.error("[knowledge/capturaSheet] Error leyendo capturas:", error);
    return null;
  }
}

/** Todas las capturas crudas (sin formatear), para el endpoint de diagnóstico. */
export async function obtenerCapturasCrudas(): Promise<
  Array<{ fecha: string; autor: string; texto: string; empresas: string }>
> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:D10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const filas = resp.data.values ?? [];
  return filas
    .filter((fila) => fila[2])
    .map((fila) => ({
      fecha: fila[0] ? String(fila[0]) : "",
      autor: fila[1] ? String(fila[1]) : "",
      texto: String(fila[2]),
      empresas: fila[3] ? String(fila[3]) : "",
    }));
}
