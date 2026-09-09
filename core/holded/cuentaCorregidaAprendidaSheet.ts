import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { conMutex } from "../utils/asyncMutex";

/**
 * Hallazgo real de auditoría (verificado en vivo): textosParecidos (match
 * por palabra compartida, pensado para precedente DIFUSO) hacía que "Un
 * Proveedor Que Jamas Existio 999" coincidiera con "Proveedor De Prueba
 * XYZ" — ambos comparten la palabra "Proveedor". Para un tier de MÁXIMA
 * confianza que pasa por encima de cualquier otra inferencia (ver tier 0 de
 * inferirCuentaGasto), un falso positivo así es mucho más peligroso que en
 * los tiers normales — se necesita el mismo criterio de match EXACTO (tras
 * normalizar) que ya usa proveedorAliasSheet.ts para su propio mapeo de
 * máxima confianza, no fuzzy matching.
 */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_cuentas_corregidas_aprendidas";
const HEADERS = ["proveedor", "empresa", "cuentaId", "cuentaNombre", "confirmadoEn"];
const MAX_INTENTOS_ESCRITURA = 3;

/**
 * Pedido explícito de Carlos: "que la práctica y los días te vayan dando la
 * experiencia... para que cada día seas más inteligente y rápido" — mismo
 * principio que los otros mecanismos de memoria, aplicado a la cuenta
 * contable de un gasto: inferirCuentaGasto (más abajo en este mismo
 * archivo) ya se beneficia PASIVAMENTE de una corrección hecha a mano en
 * Holded (sus tiers 1/2 buscan precedente en compras YA existentes, con
 * datos siempre en vivo) — pero eso es implícito y silencioso, sin ninguna
 * confirmación explícita ni forma de verlo. Este store, alimentado por
 * revisarCorreccionesCuentaContable.ts (job periódico que compara la cuenta
 * asignada al crear un gasto contra su cuenta actual en Holded), guarda una
 * confirmación EXPLÍCITA cuando detecta que Carlos corrigió la cuenta a
 * mano — inferirCuentaGasto la consulta PRIMERO, antes que cualquier tier,
 * exactamente igual que clasificacionAprendidaSheet.ts se consulta antes de
 * proponer una clasificación.
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
    range: `${TAB_NAME}!A1:E1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabAsegurada = true;
}

export interface CuentaCorregidaAprendida {
  rowIndex: number;
  proveedor: string;
  empresa: string;
  cuentaId: string;
  cuentaNombre: string;
  confirmadoEn: string;
}

async function leerFilas(): Promise<CuentaCorregidaAprendida[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:E10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: CuentaCorregidaAprendida[] = [];
  rows.forEach((row, i) => {
    if (!row[0]) return;
    result.push({
      rowIndex: i + 2,
      proveedor: String(row[0]),
      empresa: row[1] ? String(row[1]) : "",
      cuentaId: row[2] ? String(row[2]) : "",
      cuentaNombre: row[3] ? String(row[3]) : "",
      confirmadoEn: row[4] ? String(row[4]) : "",
    });
  });
  return result;
}

/**
 * Cuenta confirmada a mano para este proveedor+empresa, o undefined si nunca
 * se detectó una corrección. Match exacto (normalizado) — ver comentario de
 * normalizar() arriba.
 *
 * Hallazgo real de auditoría xhigh (2ª pasada, 2 agentes independientes):
 * el gate `contradiceCategoria` que el tier 0 de inferirCuentaGasto (write.ts)
 * usaba para "proteger" esta corrección era en realidad AUTO-DERROTABLE —
 * comparaba contra evidencia agregada de categoría que casi siempre INCLUYE
 * las mismas líneas históricas mal archivadas que motivaron la corrección en
 * primer lugar (ej. 2+ compras viejas, ya mal archivadas, con el tag correcto
 * pero la cuenta vieja) — así que el gate podía vetar justo la corrección que
 * existe para arreglar ese patrón. Se quitó ese gate del tier 0 (write.ts
 * confía en `corregida` sin cruzarla contra categoría — es un HECHO verificado
 * por el job semanal contra Holded real, no una inferencia estadística como
 * tiers 1/2/3, que sí necesitan ese cruce). La protección real contra que una
 * corrección se vuelva obsoleta ahora es el TTL de `confirmadoEn` (ver
 * TTL_CORRECCION_VIGENTE_MS en write.ts) — vence sola y vuelve a los tiers
 * normales en vez de confiar para siempre. La calidad de ENTRADA a esta tabla
 * también se reforzó: revisarCorreccionesCuentaContable.ts ahora exige que
 * TODAS las líneas de la compra compartan una única cuenta (no solo la
 * primera) antes de registrar una corrección, y gastoCallbackHandler.ts ya no
 * registra la asignación original si la empresa final difiere de la empresa
 * para la que se infirió la cuenta (evita contaminación cruzada entre
 * empresas).
 */
export async function buscarCuentaCorregidaAprendida(proveedor: string, empresa: string): Promise<CuentaCorregidaAprendida | undefined> {
  const filas = await leerFilas();
  const objetivo = normalizar(proveedor);
  return filas.find((f) => f.empresa === empresa && normalizar(f.proveedor) === objetivo);
}

/**
 * Registra (o refuerza) que este proveedor corresponde a esta cuenta —
 * llamado por revisarCorreccionesCuentaContable.ts cuando detecta que la
 * cuenta actual de un gasto en Holded ya no coincide con la que se le
 * asignó al crearlo (ver asignacionCuentaLogSheet.ts).
 */
export async function registrarCuentaCorregidaAprendida(proveedor: string, empresa: string, cuentaId: string, cuentaNombre: string): Promise<void> {
  if (!proveedor.trim() || !cuentaId.trim()) return;

  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const objetivo = normalizar(proveedor);
  await conMutex(`cuentaCorregidaAprendida:${TAB_NAME}`, async () => {
    const filas = await leerFilas();
    const match = filas.find((f) => f.empresa === empresa && normalizar(f.proveedor) === objetivo);

    if (match) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!C${match.rowIndex}:E${match.rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [[cuentaId, cuentaNombre, new Date().toISOString()]] },
      });
      return;
    }

    const filaNueva = [proveedor, empresa, cuentaId, cuentaNombre, new Date().toISOString()];
    for (let intento = 0; intento < MAX_INTENTOS_ESCRITURA; intento++) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A:E`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const filaLibre = (resp.data.values ?? []).length + 1;

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${filaLibre}:E${filaLibre}`,
        valueInputOption: "RAW",
        requestBody: { values: [filaNueva] },
      });

      const verificacion = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${filaLibre}:E${filaLibre}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const filaEscrita = verificacion.data.values?.[0] ?? [];
      const coincide = filaNueva.every((v, i) => String(filaEscrita[i] ?? "") === String(v));
      if (coincide) return;

      console.error(
        `[cuentaCorregidaAprendidaSheet] Colisión al escribir en "${TAB_NAME}", fila ${filaLibre} — reintento ${intento + 1}/${MAX_INTENTOS_ESCRITURA}.`
      );
    }
    throw new Error(`No se pudo registrar la cuenta corregida aprendida tras ${MAX_INTENTOS_ESCRITURA} intentos por colisiones repetidas.`);
  });
}

/** Todas las cuentas corregidas aprendidas — para el reporte de aprendizaje (ver core/tools/reporteAprendizaje.ts). */
export async function obtenerTodasLasCuentasCorregidas(): Promise<CuentaCorregidaAprendida[]> {
  return leerFilas();
}
