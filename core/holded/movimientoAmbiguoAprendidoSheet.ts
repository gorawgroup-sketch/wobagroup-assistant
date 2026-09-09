import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { palabrasDe, palabrasParecidas } from "../utils/textoParecido";
import { conMutex } from "../utils/asyncMutex";

/**
 * Hallazgo real de auditoría: match exacto para PROVEEDOR (no fuzzy) —
 * mismo criterio, mismo motivo que cuentaCorregidaAprendidaSheet.ts (verificado
 * en vivo esa noche: "Un Proveedor Que Jamas Existio 999" coincidía por
 * error con "Proveedor De Prueba XYZ" vía textosParecidos, ambos comparten
 * la palabra "Proveedor"). Acá el riesgo es menor (esto solo resalta con
 * ⭐, nunca decide solo — Carlos siempre revisa y toca el botón), pero la
 * misma protección es igual de barata de aplicar y evita CUALQUIER duda.
 */
function normalizarProveedor(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
  rowIndex: number;
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
  const result: MovimientoAmbiguoAprendido[] = [];
  rows.forEach((row, i) => {
    if (!row[0]) return;
    result.push({
      rowIndex: i + 2,
      proveedor: String(row[0]),
      empresa: row[1] ? String(row[1]) : "",
      descripcionMovimiento: row[2] ? String(row[2]) : "",
    });
  });
  return result;
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

/**
 * Registra que, para este proveedor, un movimiento con esta descripción real
 * fue el elegido entre varios ambiguos.
 *
 * Hallazgo real de auditoría xhigh (4 agentes independientes): a diferencia
 * de sus 3 stores hermanos (clasificacionAprendidaSheet.ts,
 * proveedorAliasSheet.ts, cuentaCorregidaAprendidaSheet.ts), esta función
 * NUNCA revisaba si el mismo (proveedor, empresa, descripcionMovimiento) ya
 * existía antes de agregar — cada confirmación de un proveedor recurrente
 * (ej. un cargo mensual ambiguo cada ciclo) agregaba una fila nueva sin
 * límite, inflando el conteo de reporteAprendizaje.ts y, más grave, con
 * leerFilas() acotado a A2:D10000, empujando eventualmente los
 * aprendizajes más viejos y establecidos fuera del rango leído. Ahora
 * actualiza `confirmadoEn` de la fila existente en vez de duplicar.
 */
export async function registrarMovimientoAmbiguoElegido(proveedor: string, empresa: string, descripcionMovimiento: string): Promise<void> {
  if (!proveedor.trim() || !descripcionMovimiento.trim()) return;

  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();
  const proveedorNormalizado = normalizarProveedor(proveedor);
  const descripcionNormalizada = normalizarProveedor(descripcionMovimiento);
  const fila = [proveedor, empresa, descripcionMovimiento, new Date().toISOString()];

  await conMutex(`movimientoAmbiguoAprendido:${TAB_NAME}`, async () => {
    const existentes = await leerFilas();
    const match = existentes.find(
      (f) =>
        f.empresa === empresa &&
        normalizarProveedor(f.proveedor) === proveedorNormalizado &&
        normalizarProveedor(f.descripcionMovimiento) === descripcionNormalizada
    );
    if (match) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!D${match.rowIndex}:D${match.rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [[new Date().toISOString()]] },
      });
      return;
    }

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
 * Puntúa cuánto se parece `descripcion` a `aprendida` — suma la longitud de
 * cada palabra distintiva (5+ caracteres) de `descripcion` que aparece
 * parecida en `aprendida`. 0 si ninguna coincide.
 */
function puntuarCoincidencia(descripcion: string, aprendida: string): number {
  const palabrasDescripcion = palabrasDe(descripcion, 5);
  const palabrasAprendida = palabrasDe(aprendida, 3);
  let score = 0;
  for (const pd of palabrasDescripcion) {
    if (palabrasAprendida.some((pa) => palabrasParecidas(pd, pa))) score += pd.length;
  }
  return score;
}

/**
 * Entre varios candidatos ambiguos, devuelve el índice del que mejor
 * coincide con algo ya confirmado antes para este proveedor — undefined si
 * ninguno coincide o nunca se ha confirmado nada para él. Solo se usa para
 * RESALTAR una opción en el mensaje (ver ofrecerEleccionMovimientosAmbiguos)
 * — nunca decide sola, Carlos siempre elige con el botón.
 *
 * Hallazgo real de auditoría xhigh: la versión anterior usaba
 * `candidatos.findIndex(...)`, quedándose con el PRIMER candidato (en el
 * orden en que Holded devolvió los movimientos bancarios) que coincidiera
 * con CUALQUIER descripción aprendida — mismo defecto ya documentado y
 * corregido en buscarContactoHolded (write.ts, ver puntuarDistintividad):
 * si dos aprendizajes distintos para este proveedor existen (ej. "PAYPAL
 * *PROVEEDORX" y "PROVEEDOR X SL AMSTERDAM"), el candidato con la
 * coincidencia MÁS FUERTE puede perder contra uno con una coincidencia más
 * débil solo por venir antes en la lista. Ahora se puntúa cada candidato
 * contra TODAS las descripciones aprendidas y gana el de mayor puntaje.
 */
export async function sugerirCandidatoAprendido(proveedor: string, empresa: string, candidatos: { descripcion?: string }[]): Promise<number | undefined> {
  if (!proveedor.trim() || candidatos.length === 0) return undefined;

  const aprendidos = await leerFilas();
  const proveedorNormalizado = normalizarProveedor(proveedor);
  const coincidenciasProveedor = aprendidos.filter(
    (a) => a.empresa === empresa && normalizarProveedor(a.proveedor) === proveedorNormalizado
  );
  if (coincidenciasProveedor.length === 0) return undefined;

  let mejorIdx: number | undefined;
  let mejorScore = 0;
  candidatos.forEach((c, i) => {
    if (!c.descripcion) return;
    const score = Math.max(0, ...coincidenciasProveedor.map((a) => puntuarCoincidencia(c.descripcion!, a.descripcionMovimiento)));
    if (score > mejorScore) {
      mejorScore = score;
      mejorIdx = i;
    }
  });
  return mejorIdx;
}

/** Todos los aprendizajes de conciliación ambigua — para el reporte de aprendizaje (ver core/tools/reporteAprendizaje.ts). */
export async function obtenerTodosLosMovimientosAprendidos(): Promise<MovimientoAmbiguoAprendido[]> {
  return leerFilas();
}
