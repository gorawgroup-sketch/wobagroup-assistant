/**
 * Filtro «solo ingresos / solo gastos» para los movimientos del banco que faltan en el cashflow.
 *
 * Caso real (Carlos, 2026-10-07, EWORKS): pidió registrar «solo los ingresos» pendientes y proponer_registro_cashflow le mandó
 * TODOS los movimientos sin registrar de la semana, ingresos y gastos mezclados (el asistente solo pudo decirle qué botones eran
 * ingresos y que descartara el resto). Cada candidato ya sabe si es ingreso o gasto: faltaba poder pedirlo.
 *
 * Reglas: lo filtrado nunca desaparece en silencio —se dice cuántos movimientos de cada clase se ocultaron y cómo verlos—, y un
 * valor de filtro que no se entiende es un error, no un «todos» silencioso.
 */
export type TipoMovimiento = "ingresos" | "gastos" | "todos";

const INGRESOS = new Set(["ingreso", "ingresos", "entrada", "entradas", "cobro", "cobros", "abono", "abonos"]);
const GASTOS = new Set(["gasto", "gastos", "salida", "salidas", "pago", "pagos", "cargo", "cargos"]);

export function leerTipoMovimiento(valor: unknown): TipoMovimiento | { error: string } {
  if (valor === undefined || valor === null || valor === "") return "todos";
  const t = String(valor).trim().toLowerCase();
  if (t === "todos" || t === "todo" || t === "ambos") return "todos";
  if (INGRESOS.has(t)) return "ingresos";
  if (GASTOS.has(t)) return "gastos";
  return { error: `tipo_movimiento «${String(valor)}» no es válido: usa ingresos, gastos o todos.` };
}

export interface ResultadoFiltroTipo<T> { visibles: T[]; ocultosIngresos: number; ocultosGastos: number }

export function filtrarPorTipo<T>(items: readonly T[], tipo: TipoMovimiento, esIngreso: (item: T) => boolean): ResultadoFiltroTipo<T> {
  if (tipo === "todos") return { visibles: [...items], ocultosIngresos: 0, ocultosGastos: 0 };
  const visibles: T[] = [];
  let ocultosIngresos = 0, ocultosGastos = 0;
  for (const item of items) {
    const ingreso = esIngreso(item);
    if ((tipo === "ingresos") === ingreso) visibles.push(item);
    else if (ingreso) ocultosIngresos += 1;
    else ocultosGastos += 1;
  }
  return { visibles, ocultosIngresos, ocultosGastos };
}

/** Nota para el usuario cuando el filtro dejó fuera algo; vacía si no se ocultó nada. */
export function notaPorFiltro(tipo: TipoMovimiento, ocultosIngresos: number, ocultosGastos: number): string {
  if (tipo === "todos") return "";
  const ocultos = tipo === "ingresos" ? ocultosGastos : ocultosIngresos;
  if (ocultos === 0) return "";
  const clase = tipo === "ingresos" ? "gasto" : "ingreso";
  return `Filtro «solo ${tipo}»: no te muestro ${ocultos} ${clase}${ocultos === 1 ? "" : "s"} sin registrar de este periodo; pídemelos con «solo ${tipo === "ingresos" ? "gastos" : "ingresos"}» o «todos».`;
}

export const etiquetaTipo = (esIngreso: boolean): "ingreso" | "gasto" => (esIngreso ? "ingreso" : "gasto");

export const DESCRIPCION_PARAMETRO_TIPO =
  "Qué clase de movimientos mostrar: 'ingresos' (entradas de dinero, cobros, abonos), 'gastos' (salidas, pagos, cargos) o 'todos' " +
  "(por defecto). Úsalo cuando el usuario pida «solo los ingresos» o «solo los gastos»: NO muestres todo para que filtre a mano.";
