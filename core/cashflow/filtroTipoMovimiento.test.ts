import assert from "node:assert/strict";
import test from "node:test";
import { formatearEmpresa } from "../tools/compararCashflowHolded";
import type { MovimientoHoldedCruce } from "./cruceHoldedCashflow";
import { etiquetaTipo, filtrarPorTipo, leerTipoMovimiento, notaPorFiltro } from "./filtroTipoMovimiento";

test("el tipo pedido se entiende con sinónimos y un valor raro es un error, nunca un «todos» silencioso", () => {
  for (const v of [undefined, null, "", "todos", "Todo", "ambos"]) assert.equal(leerTipoMovimiento(v), "todos");
  for (const v of ["ingresos", "Ingreso", "entradas", "cobros", "abonos"]) assert.equal(leerTipoMovimiento(v), "ingresos");
  for (const v of ["gastos", "gasto", "salidas", "pagos", "cargos"]) assert.equal(leerTipoMovimiento(v), "gastos");
  assert.deepEqual(leerTipoMovimiento("facturas"), { error: "tipo_movimiento «facturas» no es válido: usa ingresos, gastos o todos." });
});

// El caso real del 07-10 (EWORKS): 1 ingreso (Numu, 35.198,51 €) y 3 gastos pendientes de la semana.
const pendientes = [
  { d: "Payment From Numu Sa De Cv", esIngreso: true },
  { d: "Banco Monex / Outbox Design", esIngreso: false },
  { d: "Markel", esIngreso: false },
  { d: "Anthropic", esIngreso: false },
];

test("«solo ingresos» deja el ingreso y cuenta lo que oculta; «solo gastos» al revés; «todos» no toca nada", () => {
  const ing = filtrarPorTipo(pendientes, "ingresos", (x) => x.esIngreso);
  assert.deepEqual(ing.visibles.map((x) => x.d), ["Payment From Numu Sa De Cv"]);
  assert.deepEqual([ing.ocultosIngresos, ing.ocultosGastos], [0, 3]);
  const gas = filtrarPorTipo(pendientes, "gastos", (x) => x.esIngreso);
  assert.equal(gas.visibles.length, 3);
  assert.deepEqual([gas.ocultosIngresos, gas.ocultosGastos], [1, 0]);
  const todos = filtrarPorTipo(pendientes, "todos", (x) => x.esIngreso);
  assert.equal(todos.visibles.length, 4);
  assert.deepEqual([todos.ocultosIngresos, todos.ocultosGastos], [0, 0]);
});

test("lo filtrado no desaparece en silencio: la nota dice cuántos y cómo verlos", () => {
  assert.equal(notaPorFiltro("ingresos", 0, 3), "Filtro «solo ingresos»: no te muestro 3 gastos sin registrar de este periodo; pídemelos con «solo gastos» o «todos».");
  assert.equal(notaPorFiltro("gastos", 1, 0), "Filtro «solo gastos»: no te muestro 1 ingreso sin registrar de este periodo; pídemelos con «solo ingresos» o «todos».");
  assert.equal(notaPorFiltro("ingresos", 5, 0), "", "no se oculta nada: sin nota");
  assert.equal(notaPorFiltro("todos", 0, 0), "");
  assert.equal(etiquetaTipo(true), "ingreso");
  assert.equal(etiquetaTipo(false), "gasto");
});

const mov = (id: string, descripcion: string, valorEur: number): MovimientoHoldedCruce => ({
  id, empresa: "EWORKS", accountId: "main", cuenta: "Main", descripcion, fecha: "2026-10-06", valorEur, valorNativo: valorEur, moneda: "EUR", enPeriodo: true, toleranciaEur: 0.01,
});
const resolucionVacia = { atribuciones: [], filasSinResolver: [], filasAmbiguas: [], filasSinMovimiento: [], candidatosPorFila: [], movimientosResueltos: new Set<string>() };
const cruce = {
  empresa: "EWORKS" as const, semana: "S41", desde: "2026-10-05", hasta: "2026-10-11", desdeBancos: "2026-10-03", hastaBancos: "2026-10-13",
  coincidencias: [], filasSinMovimiento: [], ambiguos: [], filasSinEmpresa: [], problemasCobertura: [], advertenciasEstructura: [],
  movimientosSinCashflow: [mov("m1", "Payment From Numu Sa De Cv", 35198.51), mov("m2", "Banco Monex / Outbox Design", -3307.36)],
};

test("el informe de verificación indica ingreso o gasto en cada línea y respeta «solo ingresos»", () => {
  const todos = formatearEmpresa(cruce, "banco_a_cashflow", resolucionVacia);
  assert.match(todos, /2 movimiento\(s\) sin fila confirmada/);
  assert.match(todos, /Payment From Numu Sa De Cv · ingreso de 35198\.51 EUR/);
  assert.match(todos, /Banco Monex \/ Outbox Design · gasto de 3307\.36 EUR/);

  const soloIngresos = formatearEmpresa(cruce, "banco_a_cashflow", resolucionVacia, "ingresos");
  assert.match(soloIngresos, /1 ingresos sin fila confirmada/);
  assert.match(soloIngresos, /Numu/);
  assert.doesNotMatch(soloIngresos, /Outbox/);
  assert.match(soloIngresos, /Filtro «solo ingresos»: no te muestro 1 gasto sin registrar/);

  const soloGastos = formatearEmpresa(cruce, "banco_a_cashflow", resolucionVacia, "gastos");
  assert.doesNotMatch(soloGastos, /Numu/);
  assert.match(soloGastos, /Filtro «solo gastos»: no te muestro 1 ingreso sin registrar/);
});

test("si el filtro deja la lista vacía, el informe dice que no hay de ese tipo y que sí hay del otro", () => {
  const soloGastosSinGastos = formatearEmpresa({ ...cruce, movimientosSinCashflow: [mov("m1", "Payment From Numu Sa De Cv", 35198.51)] }, "banco_a_cashflow", resolucionVacia, "gastos");
  assert.match(soloGastosSinGastos, /no hay gastos confirmados como ausentes/);
  assert.match(soloGastosSinGastos, /no te muestro 1 ingreso/);
});
