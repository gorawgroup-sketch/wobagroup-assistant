import { getSheetsClient } from "./sheetsClient";
import { CacheLectura, type LecturaConMeta } from "../utils/readCache";
import { enteroAcotado } from "../utils/asyncTimeout";
import { analizarMatrizCashflow, type ProblemaEstructuraDatos } from "./cashflowLayout";

export type { ProblemaEstructuraDatos } from "./cashflowLayout";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;

// Hoja CASHFLOW: fila 5 = semanas (headers), 6 = balance inicial, 7 = income,
// 8 = project expenses, 9 = general expenses, 10 = diferencias (no usada), 11 = balance final.
const RESUMEN_RANGE = "CASHFLOW!C5:ZZ11";

export interface ResumenSemana {
  semana: string;
  balanceInicial: string;
  income: string;
  projectExpenses: string;
  generalExpenses: string;
  balanceFinal: string;
}

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

/**
 * Lee el resumen semanal ya calculado (valores, no fórmulas) de la hoja CASHFLOW.
 */
async function cargarResumenSemanas(): Promise<ResumenSemana[]> {
  const sheetId = assertSheetId();
  const sheets = getSheetsClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: RESUMEN_RANGE,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const [semanas = [], balanceInicial = [], income = [], projectExpenses = [], generalExpenses = [], , balanceFinal = []] =
    rows;

  const result: ResumenSemana[] = [];
  semanas.forEach((semana, i) => {
    if (!semana) return;
    result.push({
      semana: String(semana),
      balanceInicial: balanceInicial[i] ?? "",
      income: income[i] ?? "",
      projectExpenses: projectExpenses[i] ?? "",
      generalExpenses: generalExpenses[i] ?? "",
      balanceFinal: balanceFinal[i] ?? "",
    });
  });

  return result;
}

const CACHE_RESUMEN_TTL_MS = enteroAcotado(process.env.WOBI_CASHFLOW_CACHE_TTL_MS, 10_000, 0, 60_000);
const cacheResumen = new CacheLectura<ResumenSemana[]>("cashflow_resumen", CACHE_RESUMEN_TTL_MS);

export function fetchResumenSemanasConMeta(): Promise<LecturaConMeta<ResumenSemana[]>> {
  return cacheResumen.obtener(cargarResumenSemanas);
}

export async function fetchResumenSemanas(): Promise<ResumenSemana[]> {
  return (await fetchResumenSemanasConMeta()).datos;
}

export type DetalleCategoria =
  | "INGRESOS"
  | "PAGOS_PROYECTOS"
  | "PAGOS_EXTRAS"
  | "IMPUESTOS_POR_PAGAR"
  | "APLAZAMIENTO_IMPUESTOS"
  | "GASTOS_FIJOS"
  | "GASTOS_CONSULTORES_MES_ACTUAL"
  | "GASTOS_CONSULTORES_PROXIMO_MES"
  | "PAGOS_PENDIENTES_ALBERTO"
  | "DEUDAS_PENDIENTES";

export type EmpresaTag = "WOBA" | "EWORKS";

export interface DetalleRegistro {
  categoria: DetalleCategoria;
  /** Fila real dentro de DATOS, útil como identidad estable dentro de una lectura y para auditoría. */
  fila?: number;
  cliente?: string;
  proyecto?: string;
  concepto?: string;
  semana: string;
  valor: string;
  /** Solo presente en GASTOS_FIJOS — banco desde el que se paga, descubierto por encabezado. */
  banco?: string;
  /**
   * Solo presente en IMPUESTOS_POR_PAGAR, APLAZAMIENTO_IMPUESTOS, PAGOS_PENDIENTES_ALBERTO y
   * DEUDAS_PENDIENTES — columna AÑO/AÑ0 de la tabla detectada.
   */
  anio?: string;
  /**
   * Empresa DUEÑA del movimiento (WOBA | EWORKS), leída de la columna de tag.
   * La columna se descubre por su encabezado en cada lectura, sin depender de
   * una letra fija. Es undefined únicamente cuando la tabla real no contiene
   * EMPRESA; ese caso se conserva como no atribuible y nunca debe aplicarse a
   * WOBA y EWORKS a la vez en un informe contable.
   */
  empresa?: EmpresaTag;
}

// Compatibilidad temporal con el escritor de Pendientes, que aún usa el rango W:AB.
// La lectura ya no depende de este offset: cashflowLayout descubre la posición real en cada consulta.
export const SECCION_IDX_CLIENTE_PENDIENTES = 3;

// Cache muy corta (unos segundos) en memoria — pensada para colapsar las
// MUCHAS llamadas repetidas que ocurren dentro de una sola pregunta del
// usuario (ej. "qué está por vencer y cuánto suma" puede disparar 8-10
// búsquedas distintas — una por palabra clave de cada vencimiento — cada
// una releyendo la hoja completa desde cero). No es una cache de larga
// duración: el cashflow puede cambiar por una aprobación real en cualquier
// momento, así que se vence rápido a propósito, solo para el "ráfaga" de
// llamadas de un mismo turno de conversación.
const CACHE_DETALLE_TTL_MS = enteroAcotado(process.env.WOBI_CASHFLOW_CACHE_TTL_MS, 10_000, 0, 60_000);
const cacheDetalle = new CacheLectura<DetalleRegistro[]>("cashflow_detalle", CACHE_DETALLE_TTL_MS);

/**
 * La verificación se recalcula sobre cada fotografía fresca. El analizador dinámico absorbe
 * movimientos de filas/columnas; aquí solo se conserva lo que no pudo resolver sin inventar datos.
 */
let ultimaVerificacionEstructura: ProblemaEstructuraDatos[] = [];

/** Problemas de estructura detectados en la última lectura FRESCA (no cacheada) de fetchDetalleRegistros. */
export function obtenerUltimaVerificacionEstructura(): ProblemaEstructuraDatos[] {
  return ultimaVerificacionEstructura;
}

/**
 * Lee TODOS los movimientos de detalle de la hoja DATOS: ingresos, pagos a
 * proyectos, pagos extras, impuestos por pagar, aplazamientos de impuestos,
 * gastos fijos (nóminas, créditos, servicios), gastos consultores (mes
 * actual y próximo mes, categorías propias) y pendientes (Alberto / deudas
 * con otros), sin filtrar.
 */
async function cargarDetalleRegistros(): Promise<DetalleRegistro[]> {
  const sheetId = assertSheetId();
  const sheets = getSheetsClient();

  // Una sola fotografía amplia sustituye los rangos fijos. El analizador encuentra títulos,
  // encabezados y límites en cada lectura fresca, por lo que insertar filas o columnas no obliga
  // a Carlos a explicar manualmente qué movió ni deja movimientos invisibles en silencio.
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    // El nombre de la pestaña sin coordenadas devuelve su rango usado. Así
    // insertar columnas a cualquier lado o superar AB/500 no vuelve a ocultar
    // datos por un límite codificado en la aplicación.
    range: "DATOS",
    valueRenderOption: "FORMATTED_VALUE",
  });

  const { registros, problemas } = analizarMatrizCashflow((resp.data.values ?? []) as unknown[][]);

  if (problemas.length > 0) {
    console.error(
      `[cashflowSheet] Datos que no pudieron resolverse automáticamente — ${problemas.length} problema(s):\n` +
        problemas.map((p) => `  • [${p.bloque}] ${p.detalle}`).join("\n")
    );
  }
  ultimaVerificacionEstructura = problemas;

  return registros;
}

export function fetchDetalleRegistrosConMeta(): Promise<LecturaConMeta<DetalleRegistro[]>> {
  return cacheDetalle.obtener(cargarDetalleRegistros);
}

export async function fetchDetalleRegistros(): Promise<DetalleRegistro[]> {
  return (await fetchDetalleRegistrosConMeta()).datos;
}

/** Invalida la cache de arriba — llamar justo después de escribir en DATOS para que la próxima lectura sea fresca. */
export function invalidarCacheDetalleRegistros(): void {
  cacheDetalle.invalidar();
}

export function invalidarCachesCashflow(): void {
  cacheResumen.invalidar();
  cacheDetalle.invalidar();
}
