import assert from "node:assert/strict";
import test from "node:test";
import type { DetalleRegistro } from "./cashflowSheet";
import {
  categoriasPorTitulo,
  consultarCashflow,
  formatearResultadoCashflow,
  importeDeTexto,
  normalizarSemana,
  type ConsultaCashflow,
} from "./buscarEnCashflow";

/** Réplica de las filas reales de la hoja DATOS leídas en producción el 2026-09-21. */
function impuesto(fila: number, concepto: string, semana: string, valor: string): DetalleRegistro {
  return { categoria: "IMPUESTOS_POR_PAGAR", fila, concepto, semana, valor, anio: "2026" };
}

function hoja(): DetalleRegistro[] {
  return [
    impuesto(28, "MOD 115 WOBA Q2", "S43", "€1,867.22"),
    impuesto(29, "MOD 111 WOBA Q2", "S43", "€7,903.62"),
    impuesto(30, "MOD 111 EWORKS Q2", "S43", "€686.75"),
    impuesto(31, "MOD 303 EWORKS Q2", "S43", "€2,965.64"),
    impuesto(32, "MOD 303 EWORKS Q4 - 25", "S38", "€351.31"),
    impuesto(33, "MOD 303 WOBA", "S30", "€0.00"),
    impuesto(34, "Providencia de apremio", "S38", "€747.31"),
    impuesto(35, "Sanción AEAT", "S41", "€137.62"),
    { categoria: "APLAZAMIENTO_IMPUESTOS", fila: 48, concepto: "MOD 303 Q3 WOBA 2024", semana: "S39", valor: "€370.83", anio: "2026" },
    { categoria: "APLAZAMIENTO_IMPUESTOS", fila: 54, concepto: "MOD 200 205 EWORKS", semana: "S41", valor: "€1,186.00", anio: "2027" },
    { categoria: "GASTOS_FIJOS", fila: 20, concepto: "Impuestos seg social", semana: "S40", valor: "€12,000.00", banco: "BBVA" },
    { categoria: "GASTOS_FIJOS", fila: 21, concepto: "Telefonica", semana: "S41", valor: "€94.90", banco: "BBVA" },
    { categoria: "INGRESOS", fila: 8, cliente: "ELSAMEX", proyecto: "FEE MENSUAL", semana: "S38", valor: "€2,783.00", empresa: "WOBA" },
    { categoria: "INGRESOS", fila: 9, cliente: "ELSAMEX", proyecto: "FEE MENSUAL UAX", semana: "S38", valor: "€629.20", empresa: "EWORKS" },
    { categoria: "PAGOS_PENDIENTES_ALBERTO", fila: 5, cliente: "Reintegro Alberto", semana: "S40", valor: "€1,500.00", empresa: "WOBA" },
  ];
}

const nombres = (r: ReturnType<typeof consultarCashflow>) => r.coincidencias.map((c) => c.registro.concepto ?? c.registro.cliente);

test("CASO REAL: con empresa=EWORKS 'apremio' y 'sanción' SÍ aparecen (la sección no tiene columna de empresa)", () => {
  for (const [texto, esperado] of [["apremio", "Providencia de apremio"], ["sanción", "Sanción AEAT"], ["sancion", "Sanción AEAT"], ["SANCIÓN", "Sanción AEAT"]] as const) {
    const r = consultarCashflow(hoja(), { empresa: "EWORKS", texto });
    assert.deepEqual(nombres(r), [esperado], texto);
    assert.equal(r.coincidencias[0].atribucion, "sin_empresa", "no se inventa una empresa");
    assert.equal(r.aproximado, false);
  }
});

test("por importe: '747' y '137' (como los buscó Wobi) y el valor exacto encuentran las dos filas", () => {
  const exacto = consultarCashflow(hoja(), { valor: 747.31 });
  assert.deepEqual(nombres(exacto), ["Providencia de apremio"]);
  assert.equal(exacto.coincidencias[0].calidad, "exacta");
  assert.equal(exacto.aproximado, false);

  for (const [texto, esperado] of [["747", "Providencia de apremio"], ["137", "Sanción AEAT"], ["747,31€", "Providencia de apremio"], ["€137.62", "Sanción AEAT"]] as const) {
    const r = consultarCashflow(hoja(), { empresa: "EWORKS", texto });
    assert.deepEqual(nombres(r), [esperado], texto);
  }
  const aprox = consultarCashflow(hoja(), { valor: 747 });
  assert.deepEqual(nombres(aprox), ["Providencia de apremio"]);
  assert.equal(aprox.aproximado, true, "747 vs 747,31 es coincidencia cercana, no exacta");
  assert.match(aprox.coincidencias[0].motivos.join(), /cercano/);

  assert.deepEqual(nombres(consultarCashflow(hoja(), { valor: 747.31, toleranciaEur: 0 })), ["Providencia de apremio"]);
  assert.equal(consultarCashflow(hoja(), { valor: 750, toleranciaEur: 0.5 }).coincidencias.length, 0);
});

test("por título de sección: 'impuestos por pagar' devuelve solo esa tabla, con o sin filtro de empresa", () => {
  for (const consulta of [{ categoria: "impuestos por pagar" }, { texto: "Impuestos por Pagar" }, { categoria: "IMPUESTOS POR PAGAR" }] as ConsultaCashflow[]) {
    const r = consultarCashflow(hoja(), consulta);
    assert.equal(r.coincidencias.length, 8, JSON.stringify(consulta));
    assert.ok(r.coincidencias.every((c) => c.registro.categoria === "IMPUESTOS_POR_PAGAR"));
    assert.deepEqual(r.categoriasReconocidas, ["IMPUESTOS_POR_PAGAR"]);
  }
  assert.deepEqual([...new Set(consultarCashflow(hoja(), { categoria: "aplazamiento" }).coincidencias.map((c) => c.registro.categoria))], ["APLAZAMIENTO_IMPUESTOS"]);
  assert.deepEqual(categoriasPorTitulo("impuestos").sort(), ["APLAZAMIENTO_IMPUESTOS", "IMPUESTOS_POR_PAGAR"]);
  assert.deepEqual(categoriasPorTitulo("consultores").sort(), ["GASTOS_CONSULTORES_MES_ACTUAL", "GASTOS_CONSULTORES_PROXIMO_MES"]);
  assert.deepEqual(categoriasPorTitulo("no existe esta seccion"), []);
});

test("nombre + sección + importe combinados: la forma más segura", () => {
  const r = consultarCashflow(hoja(), { texto: "apremio", categoria: "impuestos por pagar", valor: 747.31, empresa: "EWORKS", semana: "S38" });
  assert.deepEqual(nombres(r), ["Providencia de apremio"]);
  assert.equal(r.filtrosRelajados.length, 0);
  // Texto e importe explícitos se exigen a la vez: un importe distinto no encuentra nada aunque el nombre coincida.
  assert.equal(consultarCashflow(hoja(), { texto: "apremio", valor: 999 }).coincidencias.length, 0);
});

test("empresa: incluye lo etiquetado, lo sin empresa y lo inferido por el nombre; aparta solo lo de la OTRA empresa", () => {
  const r = consultarCashflow(hoja(), { empresa: "EWORKS", categoria: "impuestos por pagar" });
  const porNombre = Object.fromEntries(r.coincidencias.map((c) => [c.registro.concepto, c.atribucion]));
  assert.deepEqual(porNombre, {
    "MOD 111 EWORKS Q2": "inferida_por_nombre",
    "MOD 303 EWORKS Q2": "inferida_por_nombre",
    "MOD 303 EWORKS Q4 - 25": "inferida_por_nombre",
    "Providencia de apremio": "sin_empresa",
    "Sanción AEAT": "sin_empresa",
  });
  assert.equal(r.apartadasPorEmpresa, 3, "MOD 115 WOBA, MOD 111 WOBA y MOD 303 WOBA son de la otra empresa");

  // Filas etiquetadas: se respeta la etiqueta.
  const elsamex = consultarCashflow(hoja(), { empresa: "EWORKS", texto: "elsamex" });
  assert.deepEqual(elsamex.coincidencias.map((c) => c.registro.empresa), ["EWORKS"]);
});

test("filtros que dejan el resultado vacío se relajan de uno en uno y se dice cuál", () => {
  const semana = consultarCashflow(hoja(), { texto: "apremio", semana: "S99" });
  assert.deepEqual(nombres(semana), ["Providencia de apremio"]);
  assert.deepEqual(semana.filtrosRelajados, ["semana"]);
  assert.match(formatearResultadoCashflow(semana, { texto: "apremio", semana: "S99" }), /filtro de semana/);

  const empresa = consultarCashflow(hoja(), { texto: "Reintegro", empresa: "EWORKS" });
  assert.deepEqual(nombres(empresa), ["Reintegro Alberto"]);
  assert.deepEqual(empresa.filtrosRelajados, ["empresa"]);
  assert.equal(empresa.coincidencias[0].registro.empresa, "WOBA", "y se ve que es de la otra empresa");
});

test("semana: 'S38', 's38', '38' y 'S03'/'S3' son equivalentes", () => {
  assert.equal(normalizarSemana("s38"), "S38");
  assert.equal(normalizarSemana("38"), "S38");
  assert.equal(normalizarSemana("S3"), "S03");
  assert.deepEqual(nombres(consultarCashflow(hoja(), { semana: "38", categoria: "impuestos por pagar" })), ["MOD 303 EWORKS Q4 - 25", "Providencia de apremio"]);
});

test("nombre: palabras en cualquier orden y sinónimos (Hacienda ≈ AEAT) — los sinónimos siempre son aproximados", () => {
  assert.deepEqual(nombres(consultarCashflow(hoja(), { texto: "providencia apremio" })), ["Providencia de apremio"]);
  assert.deepEqual(nombres(consultarCashflow(hoja(), { texto: "apremio providencia" })), ["Providencia de apremio"]);
  const hacienda = consultarCashflow(hoja(), { empresa: "EWORKS", texto: "Hacienda" });
  assert.ok(nombres(hacienda).includes("Sanción AEAT"));
  assert.ok(nombres(hacienda).includes("Providencia de apremio"));
  assert.ok(!nombres(hacienda).includes("Impuestos seg social"), "la Seguridad Social no es Hacienda");
  assert.equal(hacienda.aproximado, true);
  assert.match(hacienda.coincidencias.map((c) => c.motivos.join()).join(), /sinónimo/);
});

test("sección nombrada en parte: si el nombre no aparece pero el texto es un título, devuelve la sección", () => {
  const r = consultarCashflow(hoja(), { texto: "tabla de impuestos por pagar" });
  assert.equal(r.coincidencias.length, 8);
});

test("categoría desconocida: se avisa y se busca como nombre en vez de ignorarla", () => {
  const r = consultarCashflow(hoja(), { categoria: "apremio" });
  assert.equal(r.categoriaNoReconocida, "apremio");
  assert.deepEqual(nombres(r), ["Providencia de apremio"]);
  assert.match(formatearResultadoCashflow(r, { categoria: "apremio" }), /no coincide con ninguna de las 10 secciones/);
});

test("sin resultados: el mensaje detalla la cobertura y prohíbe concluir que 'no está'", () => {
  const consulta: ConsultaCashflow = { texto: "qwertyzz", empresa: "EWORKS" };
  const r = consultarCashflow(hoja(), consulta);
  assert.equal(r.coincidencias.length, 0);
  const texto = formatearResultadoCashflow(r, consulta);
  assert.match(texto, /No se encontraron movimientos para: texto «qwertyzz», empresa EWORKS/);
  assert.match(texto, /15 movimientos leídos/);
  assert.match(texto, /Impuestos por Pagar: 8/);
  assert.match(texto, /Gastos Consultores Mes Actual: 0 \(SIN FILAS/);
  assert.match(texto, /No afirmes que el pago no está/);
});

test("salida: cada línea trae categoría, semana, valor, año y el porqué; y avisa si las filas no tienen empresa", () => {
  const consulta: ConsultaCashflow = { empresa: "EWORKS", texto: "apremio" };
  const texto = formatearResultadoCashflow(consultarCashflow(hoja(), consulta), consulta);
  assert.match(texto, /\[IMPUESTOS_POR_PAGAR\] \[sin empresa en la hoja\] Providencia de apremio — S38 — €747\.31 · año 2026 ⟵ el nombre contiene «apremio»/);
  assert.match(texto, /no tienen columna EMPRESA en la hoja/);
  assert.match(texto, /no lo afirmes/);
});

test("importeDeTexto reconoce importes en formato español y anglosajón y no confunde nombres", () => {
  assert.equal(importeDeTexto("747"), 747);
  assert.equal(importeDeTexto("747,31 €"), 747.31);
  assert.equal(importeDeTexto("€1,867.22"), 1867.22);
  assert.equal(importeDeTexto("1.234,50"), 1234.5);
  assert.equal(importeDeTexto("MOD 303"), undefined);
  assert.equal(importeDeTexto("apremio"), undefined);
  assert.equal(importeDeTexto(""), undefined);
});

test("sin criterio de contenido (solo semana/empresa) lista sin relajar nada", () => {
  const r = consultarCashflow(hoja(), { semana: "S41" });
  assert.deepEqual(nombres(r).sort(), ["MOD 200 205 EWORKS", "Sanción AEAT", "Telefonica"].sort());
  assert.equal(r.filtrosRelajados.length, 0);
  assert.equal(consultarCashflow(hoja(), { semana: "S99" }).coincidencias.length, 0);
});
