import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { textosParecidos } from "../utils/textoParecido";
import { conMutex } from "../utils/asyncMutex";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_movimientos_ambiguos_aprendidos";
const HEADERS = ["proveedor", "empresa", "descripcionMovimiento", "confirmadoEn"];
const MAX_INTENTOS_ESCRITURA = 3;

/**
 * Pedido explícito de Carlos: "que la práctica y los días te vayan dando la
 * experiencia... para que cada día seas más inteligente y rápido" — mismo
 * principio que clasificacionAprendidaSheet.ts/proveedorAliasSheet.ts/
 * duplicadosConfirmadosSheet.ts, aplicado acá a la conciliación bancaria
 * ambigua: cuando buscarMovimientoSimilar encuentra VARIOS movimientos
 * parecidos (mismo monto/fecha, distinto movimiento real) y Carlos elige
 * "🔗 Conciliar con #N" (ver gastoCallbackHandler.ts), la descripción real
 * del movimiento que eligió queda guardada aquí. La próxima vez que este
 * mismo proveedor tenga una ambigüedad parecida, ofrecerEleccionMovimientosAmbiguos
 * (gastoCallbackHandler.ts) resalta con ⭐ el candidato cuya descripción
 * coincide con lo ya confirmado antes — Carlos sigue eligiendo (nunca se
 * concilia sola una ambigüedad real, es dinero), pero elige más rápido, con
 * la opción correcta ya destacada en vez de tener que leer las 3-4
 * descripciones bancarias crudas cada vez.
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
    range: `${TAB_NAME}!A1:D1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

export interface MovimientoAmbiguoAprendido {
  proveedor: string;
  empresa: string;
  descripcionMovimiento: string;
}

async function leerFilas(): Promise<MovimientoAmbiguoAprendido[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:D10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      proveedor: String(row[0]),
      empresa: row[1] ? String(row[1]) : "",
      descripcionMovimiento: row[2] ? String(row[2]) : "",
    }));
}

async function siguienteFilaLibre(): Promise<number> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:D`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = resp.data.values ?? [];
  return rows.length + 1;
}

/** Registra que, para este proveedor, un movimiento con esta descripción real fue el elegido entre varios ambiguos. */
export async function registrarMovimientoAmbiguoElegido(proveedor: string, empresa: string, descripcionMovimiento: string): Promise<void> {
  if (!proveedor.trim() || !descripcionMovimiento.trim()) return;

  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();
  const fila = [proveedor, empresa, descripcionMovimiento, new Date().toISOString()];

  await conMutex(`movimientoAmbiguoAprendido:${TAB_NAME}`, async () => {
    for (let intento = 0; intento < MAX_INTENTOS_ESCRITURA; intento++) {
      const filaLibre = await siguienteFilaLibre();
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${filaLibre}:D${filaLibre}`,
        valueInputOption: "RAW",
        requestBody: { values: [fila] },
      });

      const verificacion = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${filaLibre}:D${filaLibre}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const filaEscrita = verificacion.data.values?.[0] ?? [];
      const coincide = fila.every((v, i) => String(filaEscrita[i] ?? "") === String(v));
      if (coincide) return;

      console.error(
        `[movimientoAmbiguoAprendidoSheet] Colisión al escribir en "${TAB_NAME}", fila ${filaLibre} — reintento ${intento + 1}/${MAX_INTENTOS_ESCRITURA}.`
      );
    }
    // No crítico — perder este aprendizaje puntual no debe tumbar la conciliación real que ya se hizo.
    console.error(`[movimientoAmbiguoAprendidoSheet] No se pudo registrar el aprendizaje tras ${MAX_INTENTOS_ESCRITURA} intentos.`);
  });
}

/**
 * Entre varios candidatos ambiguos, devuelve el índice del primero cuya
 * descripción coincide con algo ya confirmado antes para este proveedor —
 * undefined si ninguno coincide o nunca se ha confirmado nada para él. Solo
 * se usa para RESALTAR una opción en el mensaje (ver ofrecerEleccionMovimientosAmbiguos)
 * — nunca decide sola, Carlos siempre elige con el botón.
 */
export async function sugerirCandidatoAprendido(proveedor: string, empresa: string, candidatos: { descripcion?: string }[]): Promise<number | undefined> {
  if (!proveedor.trim() || candidatos.length === 0) return undefined;

  const aprendidos = await leerFilas();
  const coincidenciasProveedor = aprendidos.filter((a) => a.empresa === empresa && textosParecidos(proveedor, a.proveedor));
  if (coincidenciasProveedor.length === 0) return undefined;

  const idx = candidatos.findIndex(
    (c) => c.descripcion && coincidenciasProveedor.some((a) => textosParecidos(a.descripcionMovimiento, c.descripcion!))
  );
  return idx === -1 ? undefined : idx;
}

/** Todos los aprendizajes de conciliación ambigua — para el reporte de aprendizaje (ver core/tools/reporteAprendizaje.ts). */
export async function obtenerTodosLosMovimientosAprendidos(): Promise<MovimientoAmbiguoAprendido[]> {
  return leerFilas();
}
