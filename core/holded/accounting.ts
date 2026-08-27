import type { Empresa } from "./client";

const HOLDED_API_BASE = "https://api.holded.com/api/v2";

const ENV_VAR_POR_EMPRESA: Record<Empresa, string> = {
  WOBA: "HOLDED_API_KEY_WOBA",
  EWORKS: "HOLDED_API_KEY_EWORKS",
  Footprint: "HOLDED_API_KEY_FOOTPRINT",
};

function getApiKey(empresa: Empresa): string {
  const envVar = ENV_VAR_POR_EMPRESA[empresa];
  const key = process.env[envVar];
  if (!key) throw new Error(`Falta la variable de entorno ${envVar}`);
  return key;
}

async function holdedGet(empresa: Empresa, path: string, params: Record<string, string | undefined> = {}) {
  const apiKey = getApiKey(empresa);
  const url = new URL(`${HOLDED_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error de la API de Holded (${response.status}) para ${empresa}: ${body}`);
  }

  return response.json();
}

export interface CuentaContable {
  id: string;
  number: number;
  name: string;
  /** Categoría que el propio Holded le asigna a la cuenta (ej. "Ventas e ingresos", "Financiación básica"). */
  group: string;
}

/**
 * Trae el plan contable completo de la empresa (confirmado en vivo: ~1000
 * cuentas para WOBA, viene en un solo request con `items`). Cada cuenta ya
 * trae su `group` asignado por Holded, así que no hace falta reinventar la
 * clasificación del Plan General Contable — se reutiliza la de Holded.
 */
export async function obtenerPlanContable(empresa: Empresa): Promise<CuentaContable[]> {
  const data = await holdedGet(empresa, "/accounting-accounts", { limit: "5000" });
  const items = Array.isArray(data) ? data : (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  return items
    .filter((c: any) => typeof c.number === "number")
    .map((c: any) => ({ id: c.id, number: c.number, name: c.name ?? "", group: c.group ?? "Sin grupo" }));
}

interface LineaAsientoCruda {
  date?: string;
  account?: number;
  debit?: string;
  credit?: string;
}

/**
 * Trae todas las líneas de asiento contable (el diario, no el resumen) en
 * un rango de fechas — paginado vía cursor, confirmado en vivo contra la
 * API real. Se usa para agregar el movimiento exacto del período (a
 * diferencia del `balance` de /accounting-accounts, que no está garantizado
 * que respete el rango de fechas pedido).
 */
async function obtenerAsientosEnRango(
  empresa: Empresa,
  desde: string,
  hasta: string
): Promise<LineaAsientoCruda[]> {
  const lineas: LineaAsientoCruda[] = [];
  let cursor: string | undefined;
  const MAX_PAGINAS = 100; // salvaguarda — 100 páginas x 500 líneas = 50.000 líneas, de sobra para un período normal

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const data = (await holdedGet(empresa, "/ledger-entries", {
      start_date: desde,
      end_date: hasta,
      limit: "500",
      cursor,
    })) as { items?: LineaAsientoCruda[]; has_more?: boolean; cursor?: string };

    const items = data.items ?? [];
    lineas.push(...items);

    if (!data.has_more || !data.cursor || items.length === 0) break;
    cursor = data.cursor;
  }

  return lineas;
}

export interface LineaReporteContable {
  numero: number;
  nombre: string;
  grupo: string;
  debe: number;
  haber: number;
  /** haber - debe del período — positivo en cuentas de ingreso con actividad real, negativo en cuentas de gasto. Ver nota en generarReporteContable. */
  saldo: number;
}

export interface ReporteContable {
  empresa: Empresa;
  desde: string;
  hasta: string;
  /** Cuentas de grupo PGC 1-5 (balance: financiación, inmovilizado, existencias, acreedores/deudores, financieras). */
  balance: LineaReporteContable[];
  /** Cuentas de grupo PGC 6-7 (pérdidas y ganancias: compras/gastos, ventas/ingresos). */
  perdidasGanancias: LineaReporteContable[];
  /** Suma de "saldo" de perdidasGanancias — aproximación del resultado del período (ingresos - gastos). */
  resultadoAproximado: number;
  generadoEn: string;
}

function grupoPGC(numero: number): number {
  return parseInt(String(numero)[0], 10);
}

/**
 * Reconstruye un balance/P&L agrupado a partir de los datos contables
 * reales de Holded (plan contable + diario del período) — NO es el reporte
 * oficial exportable de Holded (esa función no existe en su API, confirmado
 * en vivo probando /reports/*, /accounting/*, /documents: todos 404). Usa
 * la agrupación PGC estándar española por primer dígito del número de
 * cuenta (1-5 = balance, 6-7 = pérdidas y ganancias) — no es una
 * clasificación inventada, es la que exige la ley para cualquier plan
 * contable español, y coincide con el campo `group` que el propio Holded
 * le pone a cada cuenta.
 *
 * El "saldo" de cada línea es haber-debe del período — se eligió ese signo
 * porque para cuentas de pérdidas y ganancias reproduce exactamente lo que
 * muestra la interfaz de Holded (validado en vivo: cuenta 70000000 "Ventas
 * de mercaderías" con credit=594.21 coincide con el "594,21" que muestra el
 * reporte oficial). Para cuentas de balance el signo puede no coincidir con
 * la convención contable de "activo/pasivo en positivo" (depende del tipo
 * de cuenta) — se muestra tal cual, sin intentar adivinar esa convención
 * cuenta por cuenta.
 */
export async function generarReporteContable(empresa: Empresa, desde: string, hasta: string): Promise<ReporteContable> {
  const [plan, asientos] = await Promise.all([obtenerPlanContable(empresa), obtenerAsientosEnRango(empresa, desde, hasta)]);

  const planPorNumero = new Map(plan.map((c) => [c.number, c]));

  const acumulado = new Map<number, { debe: number; haber: number }>();
  for (const linea of asientos) {
    if (typeof linea.account !== "number") continue;
    const actual = acumulado.get(linea.account) ?? { debe: 0, haber: 0 };
    actual.debe += Number(linea.debit ?? 0) || 0;
    actual.haber += Number(linea.credit ?? 0) || 0;
    acumulado.set(linea.account, actual);
  }

  const balance: LineaReporteContable[] = [];
  const perdidasGanancias: LineaReporteContable[] = [];

  for (const [numero, { debe, haber }] of acumulado) {
    if (debe === 0 && haber === 0) continue;
    const cuenta = planPorNumero.get(numero);
    const linea: LineaReporteContable = {
      numero,
      nombre: cuenta?.name ?? `Cuenta ${numero}`,
      grupo: cuenta?.group ?? "Sin grupo",
      debe: Math.round(debe * 100) / 100,
      haber: Math.round(haber * 100) / 100,
      saldo: Math.round((haber - debe) * 100) / 100,
    };

    const g = grupoPGC(numero);
    if (g >= 1 && g <= 5) balance.push(linea);
    else if (g === 6 || g === 7) perdidasGanancias.push(linea);
    // Cuentas de grupo 8/9 (ajustes/cierre) — poco frecuentes, se omiten del reporte agrupado a propósito.
  }

  balance.sort((a, b) => a.numero - b.numero);
  perdidasGanancias.sort((a, b) => a.numero - b.numero);

  const resultadoAproximado = Math.round(perdidasGanancias.reduce((acc, l) => acc + l.saldo, 0) * 100) / 100;

  return {
    empresa,
    desde,
    hasta,
    balance,
    perdidasGanancias,
    resultadoAproximado,
    generadoEn: new Date().toISOString(),
  };
}
