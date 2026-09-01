import { getSheetsClient } from "./sheetsClient";

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
export async function fetchResumenSemanas(): Promise<ResumenSemana[]> {
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

export type DetalleCategoria =
  | "INGRESOS"
  | "PAGOS_PROYECTOS"
  | "PAGOS_EXTRAS"
  | "IMPUESTOS_POR_PAGAR"
  | "APLAZAMIENTO_IMPUESTOS"
  | "GASTOS_FIJOS"
  | "PAGOS_PENDIENTES_ALBERTO"
  | "DEUDAS_PENDIENTES";

export type EmpresaTag = "WOBA" | "EWORKS";

export interface DetalleRegistro {
  categoria: DetalleCategoria;
  cliente?: string;
  proyecto?: string;
  concepto?: string;
  semana: string;
  valor: string;
  /** Solo presente en GASTOS_FIJOS — banco desde el que se paga (columna L de DATOS). */
  banco?: string;
  /** Solo presente en IMPUESTOS_POR_PAGAR y APLAZAMIENTO_IMPUESTOS — columna AÑO de DATOS. */
  anio?: string;
  /**
   * Empresa DUEÑA del movimiento (WOBA | EWORKS), leída de la columna de tag.
   * undefined cuando el bloque no tiene esa columna (Pagos Extras, Impuestos
   * por Pagar, Aplazamiento Impuestos, Gastos Fijos, Pendientes) — no debe
   * confundirse con el nombre del cliente/proveedor.
   */
  empresa?: EmpresaTag;
}

type DetalleField = "cliente" | "proyecto" | "concepto" | "semana" | "valor" | "empresa" | "banco";

interface DetalleBlock {
  categoria: DetalleCategoria;
  range: string;
  fields: DetalleField[];
}

// Bloques de columnas fijas de la hoja DATOS. Solo Ingresos y Pagos Proyectos
// tienen columna de tag de empresa dueña (F y R respectivamente); el resto no.
// GASTOS_FIJOS (columnas I:L — nóminas, créditos, servicios, consultores,
// impuestos) se sumaba en "GENERAL EXPENSES" del resumen pero nunca se leía
// como línea individual — por eso una búsqueda de "Limpieza" no encontraba
// nada aunque la fila existiera (verificado en vivo: DATOS!I16 = "Limpieza",
// J16 = "S35", K16 = "€393.40"). PAGOS_PROYECTOS, IMPUESTOS_POR_PAGAR,
// APLAZAMIENTO_IMPUESTOS (columna N, tres secciones apiladas) y
// PAGOS_PENDIENTES_ALBERTO/DEUDAS_PENDIENTES (columna X, dos apiladas) se
// parsean aparte más abajo porque no tienen un rango de filas fijo propio.
const DETALLE_BLOCKS: DetalleBlock[] = [
  { categoria: "INGRESOS", range: "DATOS!B6:F500", fields: ["cliente", "proyecto", "semana", "valor", "empresa"] },
  { categoria: "PAGOS_EXTRAS", range: "DATOS!T6:V500", fields: ["cliente", "semana", "valor"] },
  { categoria: "GASTOS_FIJOS", range: "DATOS!I6:L500", fields: ["concepto", "semana", "valor", "banco"] },
];

// Columnas X:Z de DATOS: dos secciones apiladas bajo un título propio cada
// una ("PAGOS PENDIENTES ALBERTO" y "DEUDAS PENDIENTES OTROS"), sin un rango
// de filas fijo — se detecta el título para saber a qué categoría pertenece
// cada fila de debajo, en vez de asumir números de fila que pueden correrse.
const SECCION_PENDIENTES_RANGE = "DATOS!X1:Z300";
const TITULOS_SECCION_PENDIENTES: Record<string, DetalleCategoria> = {
  "PAGOS PENDIENTES ALBERTO": "PAGOS_PENDIENTES_ALBERTO",
  "DEUDAS PENDIENTES OTROS": "DEUDAS_PENDIENTES",
};

function parsearSeccionesPendientes(rows: string[][]): DetalleRegistro[] {
  const registros: DetalleRegistro[] = [];
  let categoriaActual: DetalleCategoria | null = null;

  for (const row of rows) {
    const cliente = String(row[0] ?? "").trim();
    const semana = String(row[1] ?? "").trim();
    const valor = String(row[2] ?? "").trim();

    if (!cliente) continue;

    const tituloCategoria = TITULOS_SECCION_PENDIENTES[cliente.toUpperCase()];
    if (tituloCategoria) {
      categoriaActual = tituloCategoria;
      continue;
    }

    if (cliente.toUpperCase() === "CLIENTE") continue; // fila de encabezado de columna
    if (!categoriaActual || !valor) continue;

    registros.push({ categoria: categoriaActual, cliente, semana, valor });
  }

  return registros;
}

// Bug real encontrado en vivo (2026-09-01): la columna N de DATOS NO es solo
// PAGOS_PROYECTOS — Carlos agregó ahí mismo, apiladas debajo, dos secciones
// nuevas ("IMPUESTOS POR PAGAR" en fila 24, "APLAZAMIENTO IMPUESTOS POR
// PAGAR" en fila 39, verificado en vivo contra el Sheet real). El código
// anterior leía TODO N6:R500 como si fuera PAGOS_PROYECTOS de punta a punta
// — las filas de impuestos (ej. "MOD 115 WOBA Q2" | "S43" | "€1,867.22" |
// "2026") se parseaban como si "MOD 115 WOBA Q2" fuera un CLIENTE real de un
// proyecto, con "2026" tratado como el campo EMPRESA — datos corrompidos en
// silencio, y las dos secciones de impuestos nunca se leían como su propia
// categoría (por eso Wobi "no las reconocía" al comparar contra Holded).
// Además, la vieja ubicación fija de APLAZAMIENTO_IMPUESTOS (columnas
// AC:AE) está VACÍA en el Sheet real — esa sección se movió aquí. Mismo
// patrón de detección de título que parsearSeccionesPendientes, pero cada
// sección tiene un esquema de columnas DISTINTO (Pagos Proyectos: cliente/
// proyecto/semana/valor/empresa, 5 columnas; los dos bloques de impuestos:
// impuesto/semana/valor/año, 4 columnas, sin columna de empresa).
const SECCION_COLUMNA_N_RANGE = "DATOS!N1:R500";
const TITULOS_SECCION_COLUMNA_N: Record<string, DetalleCategoria> = {
  "PAGOS PROYECTOS": "PAGOS_PROYECTOS",
  "IMPUESTOS POR PAGAR": "IMPUESTOS_POR_PAGAR",
  "APLAZAMIENTO IMPUESTOS POR PAGAR": "APLAZAMIENTO_IMPUESTOS",
};
const ENCABEZADOS_FILA_COLUMNA_N = new Set(["CLIENTE", "IMPUESTO"]);

function parsearSeccionesColumnaN(rows: string[][]): DetalleRegistro[] {
  const registros: DetalleRegistro[] = [];
  let categoriaActual: DetalleCategoria | null = null;

  for (const row of rows) {
    const primeraCol = String(row[0] ?? "").trim();
    if (!primeraCol) continue;

    const tituloCategoria = TITULOS_SECCION_COLUMNA_N[primeraCol.toUpperCase()];
    if (tituloCategoria) {
      categoriaActual = tituloCategoria;
      continue;
    }

    if (ENCABEZADOS_FILA_COLUMNA_N.has(primeraCol.toUpperCase())) continue; // fila de encabezado de columna
    if (!categoriaActual) continue;

    if (categoriaActual === "PAGOS_PROYECTOS") {
      const [cliente, proyecto, semana, valor, empresaRaw] = row;
      if (!String(semana ?? "").trim() && !String(valor ?? "").trim()) continue;
      const empresaNormalizada = String(empresaRaw ?? "").trim().toUpperCase();
      registros.push({
        categoria: categoriaActual,
        cliente: String(cliente ?? "").trim(),
        proyecto: String(proyecto ?? "").trim(),
        semana: String(semana ?? "").trim(),
        valor: String(valor ?? "").trim(),
        empresa: empresaNormalizada === "WOBA" || empresaNormalizada === "EWORKS" ? (empresaNormalizada as EmpresaTag) : undefined,
      });
    } else {
      // IMPUESTOS_POR_PAGAR / APLAZAMIENTO_IMPUESTOS: impuesto/semana/valor/año.
      const [concepto, semana, valor, anio] = row;
      if (!String(semana ?? "").trim() && !String(valor ?? "").trim()) continue;
      registros.push({
        categoria: categoriaActual,
        concepto: String(concepto ?? "").trim(),
        semana: String(semana ?? "").trim(),
        valor: String(valor ?? "").trim(),
        anio: String(anio ?? "").trim() || undefined,
      });
    }
  }

  return registros;
}

// Cache muy corta (unos segundos) en memoria — pensada para colapsar las
// MUCHAS llamadas repetidas que ocurren dentro de una sola pregunta del
// usuario (ej. "qué está por vencer y cuánto suma" puede disparar 8-10
// búsquedas distintas — una por palabra clave de cada vencimiento — cada
// una releyendo la hoja completa desde cero). No es una cache de larga
// duración: el cashflow puede cambiar por una aprobación real en cualquier
// momento, así que se vence rápido a propósito, solo para el "ráfaga" de
// llamadas de un mismo turno de conversación.
const CACHE_TTL_MS = 8000;
let cache: { en: number; datos: DetalleRegistro[] } | null = null;

/**
 * Lee TODOS los movimientos de detalle de la hoja DATOS: ingresos, pagos a
 * proyectos, pagos extras, aplazamientos de impuestos, gastos fijos
 * (nóminas, créditos, servicios, consultores, impuestos) y pendientes
 * (Alberto / deudas con otros), sin filtrar.
 */
export async function fetchDetalleRegistros(): Promise<DetalleRegistro[]> {
  if (cache && Date.now() - cache.en < CACHE_TTL_MS) {
    return cache.datos;
  }

  const sheetId = assertSheetId();
  const sheets = getSheetsClient();

  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges: [...DETALLE_BLOCKS.map((b) => b.range), SECCION_PENDIENTES_RANGE, SECCION_COLUMNA_N_RANGE],
    valueRenderOption: "FORMATTED_VALUE",
  });

  const valueRanges = resp.data.valueRanges ?? [];
  const registros: DetalleRegistro[] = [];

  DETALLE_BLOCKS.forEach((block, blockIdx) => {
    const rows = valueRanges[blockIdx]?.values ?? [];

    rows.forEach((row) => {
      const record: Partial<DetalleRegistro> = { categoria: block.categoria };
      block.fields.forEach((field, colIdx) => {
        const raw = row[colIdx] ?? "";
        if (field === "empresa") {
          const normalizado = String(raw).trim().toUpperCase();
          record.empresa = normalizado === "WOBA" || normalizado === "EWORKS" ? (normalizado as EmpresaTag) : undefined;
        } else {
          record[field] = raw;
        }
      });

      if (!record.semana && !record.valor) return;

      registros.push(record as DetalleRegistro);
    });
  });

  const filasPendientes = valueRanges[DETALLE_BLOCKS.length]?.values ?? [];
  registros.push(...parsearSeccionesPendientes(filasPendientes as string[][]));

  const filasColumnaN = valueRanges[DETALLE_BLOCKS.length + 1]?.values ?? [];
  registros.push(...parsearSeccionesColumnaN(filasColumnaN as string[][]));

  cache = { en: Date.now(), datos: registros };
  return registros;
}

/** Invalida la cache de arriba — llamar justo después de escribir en DATOS para que la próxima lectura sea fresca. */
export function invalidarCacheDetalleRegistros(): void {
  cache = null;
}
