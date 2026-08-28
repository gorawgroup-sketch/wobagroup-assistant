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
  /**
   * Empresa DUEÑA del movimiento (WOBA | EWORKS), leída de la columna de tag.
   * undefined cuando el bloque no tiene esa columna (Pagos Extras, Aplazamiento
   * Impuestos, Gastos Fijos, Pendientes) — no debe confundirse con el nombre
   * del cliente/proveedor.
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
// J16 = "S35", K16 = "€393.40"). PAGOS_PENDIENTES_ALBERTO y DEUDAS_PENDIENTES
// (columnas X:Z, dos secciones apiladas separadas por título) se parsean
// aparte más abajo porque no tienen un rango de columnas fijo propio.
const DETALLE_BLOCKS: DetalleBlock[] = [
  { categoria: "INGRESOS", range: "DATOS!B6:F500", fields: ["cliente", "proyecto", "semana", "valor", "empresa"] },
  { categoria: "PAGOS_PROYECTOS", range: "DATOS!N6:R500", fields: ["cliente", "proyecto", "semana", "valor", "empresa"] },
  { categoria: "PAGOS_EXTRAS", range: "DATOS!T6:V500", fields: ["cliente", "semana", "valor"] },
  { categoria: "APLAZAMIENTO_IMPUESTOS", range: "DATOS!AC6:AE500", fields: ["concepto", "semana", "valor"] },
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

/**
 * Lee TODOS los movimientos de detalle de la hoja DATOS: ingresos, pagos a
 * proyectos, pagos extras, aplazamientos de impuestos, gastos fijos
 * (nóminas, créditos, servicios, consultores, impuestos) y pendientes
 * (Alberto / deudas con otros), sin filtrar.
 */
export async function fetchDetalleRegistros(): Promise<DetalleRegistro[]> {
  const sheetId = assertSheetId();
  const sheets = getSheetsClient();

  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges: [...DETALLE_BLOCKS.map((b) => b.range), SECCION_PENDIENTES_RANGE],
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

  return registros;
}
