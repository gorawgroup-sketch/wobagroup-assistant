import test from "node:test";
import assert from "node:assert/strict";
import { analizarMatrizCashflow } from "./cashflowLayout";

type Matriz = string[][];

function poner(matriz: Matriz, fila: number, columna: number, valor: string): void {
  matriz[fila] ??= [];
  matriz[fila][columna] = valor;
}

function tablaBase(desplazamientoFilas = 0, desplazamientoColumnas = 0): Matriz {
  const matriz: Matriz = [];
  const p = (fila: number, columna: number, valor: string) =>
    poner(matriz, fila + desplazamientoFilas, columna + desplazamientoColumnas, valor);

  const seccion = (
    filaTitulo: number,
    columna: number,
    titulo: string,
    headers: string[],
    datos: string[],
    filaEncabezado = filaTitulo + 2
  ) => {
    p(filaTitulo, columna, titulo);
    headers.forEach((header, idx) => p(filaEncabezado, columna + idx, header));
    datos.forEach((dato, idx) => p(filaEncabezado + 1, columna + idx, dato));
  };

  seccion(2, 1, "INGRESOS WOBA GROUP", ["CLIENTE", "PROYECTO", "SEMANA", "VALOR", "EMPRESA"], ["Cliente A", "Proyecto A", "S40", "€1,000.00", "WOBA"]);
  seccion(2, 8, "GASTOS FIJOS", ["GASTO", "SEMANA", "VALOR", "BANCO"], ["Nómina", "S40", "€500.00", "BBVA"]);
  seccion(2, 13, "PAGOS PROYECTOS", ["CLIENTE", "PROYECTO", "SEMANA", "VALOR", "EMPRESA"], ["Cliente B", "Proyecto B", "S41", "€200.00", "EWORKS"]);
  seccion(2, 19, "PAGOS EXTRAS", ["CLIENTE", "SEMANA", "VALOR", "EMPRESA"], ["Proveedor", "S41", "€25.00", "WOBA"]);

  p(2, 25, "PAGOS PENDIENTES ALBERTO");
  p(4, 22, "EMPRESA");
  p(4, 23, "AÑ0");
  p(4, 25, "CLIENTE");
  p(4, 26, "SEMANA");
  p(4, 27, "VALOR");
  p(5, 22, "WOBA");
  p(5, 23, "2026");
  p(5, 25, "Reintegro");
  p(5, 26, "S42");
  p(5, 27, "€30.00");

  seccion(15, 25, "DEUDAS PENDIENTES OTROS", ["CLIENTE", "SEMANA", "VALOR"], ["Proveedor C", "S43", "€40.00"]);
  p(18, 22, "EWORKS");
  p(18, 23, "2027");

  seccion(15, 13, "IMPUESTOS POR PAGAR", ["IMPUESTO", "SEMANA", "VALOR", "AÑO"], ["MOD 111", "S43", "€300.00", "2026"]);
  seccion(30, 13, "APLAZAMIENTO IMPUESTOS POR PAGAR", ["IMPUESTO", "SEMANA", "VALOR", "AÑ0"], ["MOD 303", "S44", "€75.00", "2026"]);
  seccion(20, 8, "GASTOS CONSULTORES MES ACTUAL", ["CONSULTOR", "SEMANA", "VALOR"], ["Consultor A", "S40", "€600.00"]);
  seccion(30, 8, "GASTOS CONSULTORES PROXIMO MES", ["CONSULTOR", "SEMANA", "VALOR"], ["Consultor B", "S44", "€700.00"]);

  return matriz;
}

test("descubre las diez tablas aunque se inserten filas y columnas", () => {
  const resultado = analizarMatrizCashflow(tablaBase(4, 3));

  assert.deepEqual(resultado.problemas, []);
  assert.equal(resultado.registros.length, 10);
  assert.deepEqual(
    new Set(resultado.registros.map((registro) => registro.categoria)),
    new Set([
      "INGRESOS",
      "GASTOS_FIJOS",
      "PAGOS_PROYECTOS",
      "PAGOS_EXTRAS",
      "PAGOS_PENDIENTES_ALBERTO",
      "DEUDAS_PENDIENTES",
      "IMPUESTOS_POR_PAGAR",
      "APLAZAMIENTO_IMPUESTOS",
      "GASTOS_CONSULTORES_MES_ACTUAL",
      "GASTOS_CONSULTORES_PROXIMO_MES",
    ])
  );
});

test("no confunde resúmenes y errores de fórmula fuera de una tabla con movimientos", () => {
  const matriz = tablaBase();
  poner(matriz, 45, 3, "total");
  poner(matriz, 45, 4, "cada uno");
  poner(matriz, 45, 5, "Footprint");
  poner(matriz, 45, 6, "€1,600.00");
  poner(matriz, 48, 2, "Gastos personal");
  poner(matriz, 48, 3, "#VALUE!");
  poner(matriz, 48, 4, "#VALUE!");

  const resultado = analizarMatrizCashflow(matriz);

  assert.deepEqual(resultado.problemas, []);
  assert.equal(resultado.registros.length, 10);
  assert.equal(resultado.registros.some((registro) => registro.valor === "cada uno"), false);
  assert.equal(resultado.registros.some((registro) => registro.valor === "#VALUE!"), false);
});

test("aísla una fila real con importe inválido sin perder el resto de las tablas", () => {
  const matriz = tablaBase();
  poner(matriz, 5, 4, "#VALUE!");

  const resultado = analizarMatrizCashflow(matriz);

  assert.equal(resultado.registros.length, 9);
  assert.equal(resultado.registros.some((registro) => registro.categoria === "INGRESOS"), false);
  assert.equal(resultado.problemas.length, 1);
  assert.match(resultado.problemas[0].detalle, /E6.*excluyó solo esa fila/i);
});

test("falla cerrado si existen dos tablas válidas para la misma categoría", () => {
  const matriz = tablaBase();
  poner(matriz, 40, 19, "PAGOS EXTRAS");
  poner(matriz, 42, 19, "CLIENTE");
  poner(matriz, 42, 20, "SEMANA");
  poner(matriz, 42, 21, "VALOR");
  poner(matriz, 42, 22, "EMPRESA");

  const resultado = analizarMatrizCashflow(matriz);

  assert.equal(resultado.registros.some((registro) => registro.categoria === "PAGOS_EXTRAS"), false);
  assert.equal(resultado.problemas.some((problema) => /más de una tabla válida/i.test(problema.detalle)), true);
});

test("conserva empresa y fila real después de mover toda la tabla", () => {
  const resultado = analizarMatrizCashflow(tablaBase(7, 5));
  const extra = resultado.registros.find((registro) => registro.categoria === "PAGOS_EXTRAS");

  assert.equal(extra?.empresa, "WOBA");
  assert.equal(extra?.fila, 13);
});

test("rechaza Pagos Extras sin EMPRESA en vez de mezclar las compañías", () => {
  const matriz = tablaBase();
  poner(matriz, 4, 22, "");

  const resultado = analizarMatrizCashflow(matriz);

  assert.equal(resultado.registros.some((registro) => registro.categoria === "PAGOS_EXTRAS"), false);
  assert.equal(resultado.problemas.some((problema) => problema.bloque === "PAGOS_EXTRAS"), true);
});
