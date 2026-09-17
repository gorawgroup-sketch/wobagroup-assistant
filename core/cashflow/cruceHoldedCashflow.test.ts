import test from "node:test";
import assert from "node:assert/strict";
import {
  cruzarListasUnoAUno,
  parsearImporteCashflow,
  resolverFilasSinEmpresaGlobal,
  type FilaCashflowCruce,
  type MovimientoHoldedCruce,
  type ResultadoCruceCashflowHolded,
} from "./cruceHoldedCashflow";

function fila(id: string, descripcion: string, valorEur: number, tipo: "ingreso" | "gasto" = "gasto"): FilaCashflowCruce {
  return { id, empresa: "WOBA", categoria: tipo === "ingreso" ? "INGRESOS" : "PAGOS_EXTRAS", descripcion, semana: "S37", valorEur, tipo };
}

function movimiento(
  id: string,
  descripcion: string,
  valorEur: number,
  opciones: Partial<MovimientoHoldedCruce> = {}
): MovimientoHoldedCruce {
  return {
    id,
    empresa: "WOBA",
    accountId: "main",
    cuenta: "Main",
    descripcion,
    fecha: "2026-09-10",
    valorEur,
    valorNativo: valorEur,
    moneda: "EUR",
    enPeriodo: true,
    toleranciaEur: 0.01,
    ...opciones,
  };
}

function resultado(
  empresa: "WOBA" | "EWORKS",
  filasSinEmpresa: FilaCashflowCruce[],
  movimientos: MovimientoHoldedCruce[]
): ResultadoCruceCashflowHolded {
  return {
    empresa,
    semana: "S37",
    desde: "2026-09-07",
    hasta: "2026-09-13",
    desdeBancos: "2026-09-05",
    hastaBancos: "2026-09-16",
    coincidencias: [],
    filasSinMovimiento: [],
    movimientosSinCashflow: [],
    filasSinEmpresa,
    problemasCobertura: [],
    ambiguos: movimientos.map((item) => ({
      movimiento: item,
      alternativas: filasSinEmpresa.map((fila) => fila.id),
      motivo: "El importe puede corresponder a una fila del cashflow que no tiene EMPRESA",
    })),
  };
}

test("normaliza importes europeos y anglosajones sin cambiar su valor", () => {
  assert.equal(parsearImporteCashflow("€6,892.73"), 6892.73);
  assert.equal(parsearImporteCashflow("6.892,73 €"), 6892.73);
  assert.equal(parsearImporteCashflow("(1.234,56 €)"), -1234.56);
});

test("asigna uno a uno por proveedor cuando hay dos cargos del mismo importe", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Ovidio Playa", 29.5), fila("f2", "Obm Usera", 29.5)],
    [movimiento("m1", "OBM USERA", -29.5), movimiento("m2", "OVIDIO PLAYA", -29.5)]
  );

  assert.equal(resultado.coincidencias.length, 2);
  assert.deepEqual(
    new Set(resultado.coincidencias.map((c) => `${c.fila.id}:${c.movimiento.id}`)),
    new Set(["f1:m2", "f2:m1"])
  );
  assert.equal(resultado.ambiguos.length, 0);
});

test("un solo movimiento nunca cubre dos filas iguales", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Uber", 3), fila("f2", "Uber", 3)],
    [movimiento("m1", "Uber", -3)]
  );

  assert.equal(resultado.coincidencias.length, 0);
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.ambiguos.filter((a) => a.fila).length, 2);
});

test("un abono no respalda un gasto aunque el importe sea idéntico", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Proveedor", 100, "gasto")],
    [movimiento("m1", "Proveedor", 100)]
  );

  assert.equal(resultado.coincidencias.length, 0);
  assert.equal(resultado.filasSinMovimiento.length, 1);
  assert.equal(resultado.movimientosSinCashflow.length, 1);
});

test("un cargo del margen posterior puede respaldar la fila sin convertirse en otro faltante", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "RAMINATRANS", 2844.86)],
    [movimiento("m1", "RAMINATRANS S.L.", -2844.86, { fecha: "2026-09-14", enPeriodo: false })]
  );

  assert.equal(resultado.coincidencias.length, 1);
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.movimientosSinCashflow.length, 0);
});

test("una coincidencia única de empresa, signo, importe y fecha puede verificarse aunque el banco abrevie el texto", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Cuota servicio septiembre", 10.89)],
    [movimiento("m1", "DD 482991", -10.89)]
  );

  assert.equal(resultado.coincidencias.length, 1);
  assert.equal(resultado.coincidencias[0].criterio, "importe_fecha_unico");
});

test("reconoce un total consolidado solo cuando agrupa el mismo proveedor", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Amazon compras semana", 30)],
    [movimiento("m1", "WWW AMAZON", -10), movimiento("m2", "WWW AMAZON", -20)]
  );

  assert.equal(resultado.coincidencias.length, 1);
  assert.equal(resultado.coincidencias[0].criterio, "proveedor_total_agrupado");
  assert.deepEqual(resultado.coincidencias[0].movimientos.map((m) => m.id), ["m1", "m2"]);
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.movimientosSinCashflow.length, 0);
});

test("no suma proveedores diferentes para fabricar una coincidencia", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Compra consolidada", 30)],
    [movimiento("m1", "Proveedor A", -10), movimiento("m2", "Proveedor B", -20)]
  );

  assert.equal(resultado.coincidencias.length, 0);
  assert.equal(resultado.filasSinMovimiento.length, 1);
  assert.equal(resultado.movimientosSinCashflow.length, 2);
});

test("atribuye una fila sin empresa solo si el banco demuestra un dueño global único", () => {
  const sinEmpresa = { ...fila("f1", "Iberdrola", 264.46), empresa: undefined };
  const movimientoWoba = movimiento("m1", "IBERDROLA CLIENTES", -264.46);
  const resolucion = resolverFilasSinEmpresaGlobal([
    resultado("WOBA", [sinEmpresa], [movimientoWoba]),
    resultado("EWORKS", [sinEmpresa], []),
  ]);

  assert.equal(resolucion.atribuciones.length, 1);
  assert.equal(resolucion.atribuciones[0].empresa, "WOBA");
  assert.equal(resolucion.filasSinResolver.length, 0);
});

test("no atribuye una fila sin empresa si ambas compañías tienen un cargo compatible", () => {
  const sinEmpresa = { ...fila("f1", "Uber", 8.95), empresa: undefined };
  const movimientoWoba = movimiento("m1", "Uber Pending", -8.95);
  const movimientoEworks = movimiento("m2", "Uber Pending", -8.95, { empresa: "EWORKS", accountId: "ew" });
  const resolucion = resolverFilasSinEmpresaGlobal([
    resultado("WOBA", [sinEmpresa], [movimientoWoba]),
    resultado("EWORKS", [sinEmpresa], [movimientoEworks]),
  ]);

  assert.equal(resolucion.atribuciones.length, 0);
  assert.equal(resolucion.filasSinResolver.length, 1);
});
