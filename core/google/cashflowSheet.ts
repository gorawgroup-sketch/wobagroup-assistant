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
  | "APLAZAMIENTO_IMPUESTOS";

export interface DetalleRegistro {
  categoria: DetalleCategoria;
  cliente?: string;
  proyecto?: string;
  concepto?: string;
  semana: string;
  valor: string;
}

type DetalleField = "cliente" | "proyecto" | "concepto" | "semana" | "valor";

interface DetalleBlock {
  categoria: DetalleCategoria;
  range: string;
  fields: DetalleField[];
}

// Bloques de la hoja DATOS. Deliberadamente NO incluye Gastos Fijos ni
// Pagos Pendientes Alberto / Deudas Pendientes (fuera de alcance de este tool).
const DETALLE_BLOCKS: DetalleBlock[] = [
  { categoria: "INGRESOS", range: "DATOS!B6:E500", fields: ["cliente", "proyecto", "semana", "valor"] },
  { categoria: "PAGOS_PROYECTOS", range: "DATOS!N6:Q500", fields: ["cliente", "proyecto", "semana", "valor"] },
  { categoria: "PAGOS_EXTRAS", range: "DATOS!T6:V500", fields: ["cliente", "semana", "valor"] },
  { categoria: "APLAZAMIENTO_IMPUESTOS", range: "DATOS!AC6:AE500", fields: ["concepto", "semana", "valor"] },
];

/**
 * Lee los movimientos de detalle de la hoja DATOS (ingresos, pagos a proyectos,
 * pagos extras y aplazamientos de impuestos), sin filtrar.
 */
export async function fetchDetalleRegistros(): Promise<DetalleRegistro[]> {
  const sheetId = assertSheetId();
  const sheets = getSheetsClient();

  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges: DETALLE_BLOCKS.map((b) => b.range),
    valueRenderOption: "FORMATTED_VALUE",
  });

  const valueRanges = resp.data.valueRanges ?? [];
  const registros: DetalleRegistro[] = [];

  DETALLE_BLOCKS.forEach((block, blockIdx) => {
    const rows = valueRanges[blockIdx]?.values ?? [];

    rows.forEach((row) => {
      const record: Partial<DetalleRegistro> = { categoria: block.categoria };
      block.fields.forEach((field, colIdx) => {
        record[field] = row[colIdx] ?? "";
      });

      if (!record.semana && !record.valor) return;

      registros.push(record as DetalleRegistro);
    });
  });

  return registros;
}
