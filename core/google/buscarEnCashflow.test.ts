import assert from "node:assert/strict";
import test from "node:test";
import type { DetalleRegistro } from "./cashflowSheet";
import {
  categoriasPorTitulo,
  consultarCashflow,
  formatearResultadoCashflow,
  importeDeTexto,
  normalizarSemana,
  parsearEntradaConsulta,
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
    { categoria: "PAGOS_EXTRAS", fila: 3, cliente: "Aplazamiento Hacienda IRPF 2025", semana: "S44", valor: "€500.00", empresa: "EWORKS" },
  ];
}

const nombres = (r: ReturnType<typeof consultarCashflow>) => r.coincidencias.map((c) => c.registro.concepto ?? c.registro.cliente);
const q = (c: ConsultaCashflow) => consultarCashflow(hoja(), c);

test("CASO REAL: con empresa=EWORKS 'apremio' y 'sanción' SÍ aparecen a la primera, sin relajar nada (la sección no tiene columna de empresa)", () => {
  for (const [texto, esperado] of [["apremio", "Providencia de apremio"], ["sanción", "Sanción AEAT"], ["sancion", "Sanción AEAT"], ["SANCIÓN", "Sanción AEAT"]] as const) {
    const r = q({ empresa: "EWORKS", texto });
    assert.deepEqual(nombres(r), [esperado], texto);
    assert.equal(r.coincidencias[0].atribucion, "sin_empresa", "no se inventa una empresa");
    assert.equal(r.aproximado, false);
    // Si se reintrodujera la causa raíz (descartar filas sin empresa), esto solo se encontraría RELAJANDO la empresa:
    assert.deepEqual(r.filtrosRelajados, [], "encontrado sin relajar ningún filtro");
    assert.equal(r.intentos[0].filas, 1, "ya en el primer intento (todos los criterios)");
  }
});

test("por importe: '747', '137', el valor exacto y nombre+importe juntos encuentran las dos filas", () => {
  const exacto = q({ valor: 747.31 });
  assert.deepEqual(nombres(exacto), ["Providencia de apremio"]);
  assert.equal(exacto.coincidencias[0].calidad, "exacta");

  for (const [texto, esperado] of [["747", "Providencia de apremio"], ["137", "Sanción AEAT"], ["747,31€", "Providencia de apremio"], ["€137.62", "Sanción AEAT"]] as const) {
    assert.deepEqual(nombres(q({ empresa: "EWORKS", texto })), [esperado], texto);
  }
  const aprox = q({ valor: 747 });
  assert.deepEqual(nombres(aprox), ["Providencia de apremio"]);
  assert.equal(aprox.aproximado, true, "747 vs 747,31 es coincidencia cercana, no exacta");
  assert.match(aprox.coincidencias[0].motivos.join(), /difiere 0\.31 € del buscado/);

  const junto = q({ texto: "Providencia de apremio 747,31" });
  assert.deepEqual(nombres(junto), ["Providencia de apremio"]);
  assert.equal(junto.aproximado, false, "nombre e importe exactos: no es aproximado");
  assert.equal(junto.coincidencias[0].motivos.length, 2);

  assert.deepEqual(nombres(q({ valor: 747.31, toleranciaEur: 0 })), ["Providencia de apremio"]);
  assert.equal(q({ valor: 750, toleranciaEur: 0.5 }).coincidencias.length, 0);
  // La tolerancia mostrada es la aplicada: 747 → ±3.74 y una fila a 3.74 € entra.
  const borde = consultarCashflow([impuesto(1, "Borde", "S01", "€750.74")], { valor: 747 });
  assert.equal(borde.coincidencias.length, 1);
  assert.match(borde.coincidencias[0].motivos.join(), /difiere 3\.74 € del buscado \(tolerancia ±3\.74 €\)/);
});

test("por título de sección: 'impuestos por pagar' devuelve solo esa tabla", () => {
  for (const consulta of [{ categoria: "impuestos por pagar" }, { texto: "Impuestos por Pagar" }, { categoria: "IMPUESTOS POR PAGAR" }] as ConsultaCashflow[]) {
    const r = q(consulta);
    assert.equal(r.coincidencias.length, 8, JSON.stringify(consulta));
    assert.ok(r.coincidencias.every((c) => c.registro.categoria === "IMPUESTOS_POR_PAGAR"));
    assert.deepEqual(r.categoriasReconocidas, ["IMPUESTOS_POR_PAGAR"]);
  }
  assert.deepEqual([...new Set(q({ categoria: "aplazamiento" }).coincidencias.map((c) => c.registro.categoria))], ["APLAZAMIENTO_IMPUESTOS"]);
  assert.deepEqual(categoriasPorTitulo("impuestos").sort(), ["APLAZAMIENTO_IMPUESTOS", "IMPUESTOS_POR_PAGAR"]);
  assert.deepEqual(categoriasPorTitulo("consultores").sort(), ["GASTOS_CONSULTORES_MES_ACTUAL", "GASTOS_CONSULTORES_PROXIMO_MES"]);
  assert.deepEqual(categoriasPorTitulo("no existe esta seccion"), []);
});

test("un texto que nombra una sección NO oculta las filas cuyo nombre coincide (unión), y 'impuestos' ofrece también las secciones", () => {
  const aplazamiento = q({ texto: "aplazamiento" });
  const cats = new Set(aplazamiento.coincidencias.map((c) => c.registro.categoria));
  assert.ok(cats.has("APLAZAMIENTO_IMPUESTOS"), "la sección");
  assert.ok(cats.has("PAGOS_EXTRAS"), "y la fila de otra sección cuyo nombre dice 'Aplazamiento'");

  const impuestos = q({ texto: "impuestos" });
  const nom = nombres(impuestos);
  assert.ok(nom.includes("Impuestos seg social"), "por nombre");
  assert.ok(nom.includes("Providencia de apremio"), "y la sección Impuestos por Pagar, como aproximada");
  assert.ok(impuestos.coincidencias.find((c) => c.registro.concepto === "Providencia de apremio")!.calidad === "aproximada");
});

test("varias pistas a la vez: si una no casa, se relaja SOLA y se dice cuál (nombre correcto + importe/sección mal recordados)", () => {
  const importe = q({ texto: "apremio", valor: 800 });
  assert.deepEqual(nombres(importe), ["Providencia de apremio"]);
  assert.deepEqual(importe.filtrosRelajados, ["valor"]);

  const seccion = q({ texto: "apremio", categoria: "gastos fijos" });
  assert.deepEqual(nombres(seccion), ["Providencia de apremio"]);
  assert.deepEqual(seccion.filtrosRelajados, ["categoria"]);

  const cercano = q({ texto: "sanción AEAT", valor: 140 });
  assert.equal(nombres(cercano)[0], "Sanción AEAT", "la exacta primero (le siguen sinónimos como Hacienda ≈ AEAT)");
  assert.deepEqual(cercano.filtrosRelajados, ["valor"]);

  const soloImporte = q({ texto: "algo que no existe", valor: 747.31 });
  assert.deepEqual(nombres(soloImporte), ["Providencia de apremio"]);
  assert.deepEqual(soloImporte.filtrosRelajados, ["texto"], "el importe exacto manda si el nombre no aparece");

  const semana = q({ texto: "apremio", semana: "S99" });
  assert.deepEqual(semana.filtrosRelajados, ["semana"]);
  assert.match(formatearResultadoCashflow(semana, { texto: "apremio", semana: "S99" }), /exigiendo la semana/);

  const todo = q({ texto: "apremio", categoria: "impuestos por pagar", valor: 747.31, empresa: "EWORKS", semana: "S38" });
  assert.deepEqual(nombres(todo), ["Providencia de apremio"]);
  assert.equal(todo.filtrosRelajados.length, 0);
});

test("combinar sinónimos con sección o importe: 'hacienda' + sección / importe también encuentra", () => {
  assert.ok(nombres(q({ texto: "hacienda", categoria: "impuestos por pagar" })).includes("Providencia de apremio"));
  assert.ok(nombres(q({ texto: "hacienda", valor: 747.31 })).includes("Providencia de apremio"));
});

test("empresa: incluye lo etiquetado, lo sin empresa y lo inferido por el nombre; aparta lo de la OTRA empresa y lo dice", () => {
  const r = q({ empresa: "EWORKS", categoria: "impuestos por pagar" });
  const porNombre = Object.fromEntries(r.coincidencias.map((c) => [c.registro.concepto, c.atribucion]));
  assert.deepEqual(porNombre, {
    "MOD 111 EWORKS Q2": "inferida_por_nombre",
    "MOD 303 EWORKS Q2": "inferida_por_nombre",
    "MOD 303 EWORKS Q4 - 25": "inferida_por_nombre",
    "Providencia de apremio": "sin_empresa",
    "Sanción AEAT": "sin_empresa",
  });

  const mod303 = q({ empresa: "EWORKS", texto: "MOD 303" });
  assert.deepEqual(nombres(mod303).sort(), ["MOD 303 EWORKS Q2", "MOD 303 EWORKS Q4 - 25"]);
  assert.deepEqual(mod303.apartadasPorEmpresa.map((a) => a.nombre).sort(), ["MOD 303 Q3 WOBA 2024", "MOD 303 WOBA"], "solo las que coinciden con lo pedido, no todas las de la otra empresa");
  assert.match(formatearResultadoCashflow(mod303, { empresa: "EWORKS", texto: "MOD 303" }), /2 coincidencia\(s\) más pertenecen.*OTRA empresa.*MOD 303 WOBA/);

  const elsamex = q({ empresa: "EWORKS", texto: "elsamex" });
  assert.deepEqual(elsamex.coincidencias.map((c) => c.registro.empresa), ["EWORKS"]);
});

test("con la empresa relajada, una fila que el nombre atribuye a la otra empresa se etiqueta así (no 'sin empresa')", () => {
  const r = q({ texto: "MOD 115", empresa: "EWORKS" });
  assert.deepEqual(r.filtrosRelajados, ["empresa"]);
  assert.equal(r.coincidencias[0].atribucion, "otra");
  const texto = formatearResultadoCashflow(r, { texto: "MOD 115", empresa: "EWORKS" });
  assert.match(texto, /\[el nombre indica WOBA\]/);
  assert.doesNotMatch(texto, /figuran «sin empresa»/);
});

test("la inferencia de empresa por el nombre exige la PALABRA completa (WOBAX no es WOBA)", () => {
  const filas: DetalleRegistro[] = [impuesto(1, "MOD 303 WOBAX", "S01", "€10.00"), impuesto(2, "MOD 303 WOBA", "S01", "€20.00")];
  const r = consultarCashflow(filas, { empresa: "WOBA", texto: "MOD 303" });
  assert.equal(r.coincidencias.find((c) => c.registro.concepto === "MOD 303 WOBAX")?.atribucion, "sin_empresa");
  assert.equal(r.coincidencias.find((c) => c.registro.concepto === "MOD 303 WOBA")?.atribucion, "inferida_por_nombre");
});

test("sinónimos por palabra completa: 'iva' NO está en 'definitivas'; Hacienda ≈ AEAT sin arrastrar la Seguridad Social", () => {
  assert.equal(q({ texto: "definitivas" }).coincidencias.length, 0);
  assert.equal(q({ texto: "administrativa" }).coincidencias.length, 0);
  assert.ok(nombres(q({ texto: "iva" })).includes("MOD 303 EWORKS Q2"), "la palabra 'iva' sí");
  const hacienda = q({ empresa: "EWORKS", texto: "Hacienda" });
  assert.equal(hacienda.coincidencias[0].registro.cliente, "Aplazamiento Hacienda IRPF 2025", "la exacta va primero");
  assert.equal(hacienda.coincidencias[0].calidad, "exacta");
  assert.ok(nombres(hacienda).includes("Sanción AEAT"), "y lo de la AEAT por sinónimo, sin que la exacta lo oculte");
  assert.equal(hacienda.coincidencias.find((c) => c.registro.concepto === "Sanción AEAT")?.calidad, "aproximada");
  assert.ok(nombres(hacienda).includes("Providencia de apremio"));
  assert.ok(!nombres(hacienda).includes("Impuestos seg social"), "la Seguridad Social no es Hacienda");
  // Sin ninguna fila que diga "Hacienda", todo es por sinónimo y el resultado entero es aproximado.
  const sinExacta = consultarCashflow(hoja().filter((r) => !/Hacienda/.test(r.cliente ?? "")), { texto: "Hacienda" });
  assert.equal(sinExacta.aproximado, true);

  // 'AEAT' encuentra la exacta; 'apremio' no arrastra la sanción (equivalencias estrechas).
  assert.deepEqual(nombres(q({ texto: "AEAT" })), ["Sanción AEAT", "Aplazamiento Hacienda IRPF 2025"], "AEAT ≈ Hacienda, pero no arrastra la providencia");
  assert.deepEqual(nombres(q({ texto: "apremio" })), ["Providencia de apremio"]);
});

test("el banco NO forma parte del nombre buscable ('BBVA' no es un proveedor)", () => {
  assert.equal(q({ texto: "BBVA" }).coincidencias.length, 0);
  assert.equal(consultarCashflow(hoja(), { texto: "BBVA" }, { modo: "concepto" }).coincidencias.length, 0);
});

test("nombres cortos: 'luz'/'aws'/'303' cuentan como exactos solo por palabra completa", () => {
  const filas: DetalleRegistro[] = [impuesto(1, "Luz oficina", "S01", "€10.00"), impuesto(2, "Soluzione SL", "S01", "€20.00"), impuesto(3, "AWS", "S02", "€30.00")];
  const luz = consultarCashflow(filas, { texto: "luz" });
  assert.deepEqual(nombres(luz), ["Luz oficina", "Soluzione SL"].slice(0, 1).concat([]) as string[], "solo la palabra completa cuando hay exacta");
  assert.deepEqual(nombres(consultarCashflow(filas, { texto: "aws" })), ["AWS"]);
});

test("MODO CONCEPTO (consultar_proximas_alertas, que suma importes): solo nombre; sin sinónimos, importes, secciones ni relajación", () => {
  const c = (texto: string, empresa?: "WOBA" | "EWORKS") => consultarCashflow(hoja(), { texto, empresa }, { modo: "concepto" });
  assert.deepEqual(nombres(c("apremio")), ["Providencia de apremio"]);
  assert.equal(c("iva").coincidencias.length, 0, "sin sinónimos (en modo interactivo 'iva' ≈ 'MOD 303')");
  assert.ok(nombres(q({ texto: "iva" })).includes("MOD 303 EWORKS Q2"));
  assert.equal(c("747").coincidencias.length, 0, "sin importes");
  assert.deepEqual(nombres(c("impuestos por pagar")), ["Impuestos seg social"], "sin secciones: solo el parecido por palabras de siempre, nunca las 8 filas de la sección");
  assert.equal(c("definitivas").coincidencias.length, 0);
  assert.equal(c("apremio", "EWORKS").intentos.length, 1, "un solo intento: no relaja");
  const parecido = c("Seguridad social");
  assert.equal(parecido.aproximado, true);
  assert.deepEqual(nombres(parecido), ["Impuestos seg social"]);
  // exactas si las hay: una exacta oculta las parecidas (semántica de siempre, de la que depende la suma).
  assert.equal(c("MOD 303").coincidencias.length, 4, "las 4 filas MOD 303 (exactas), sin nada más");
  // La puntuación cuenta (como siempre): las claves "(pago" / "(tarjeta" del calendario fiscal no enganchan "Pago Ireri".
  const filas: DetalleRegistro[] = [{ categoria: "DEUDAS_PENDIENTES", fila: 1, cliente: "Pago Ireri", semana: "S01", valor: "€5.00" }];
  assert.equal(consultarCashflow(filas, { texto: "(pago" }, { modo: "concepto" }).coincidencias.length, 0);
  assert.equal(consultarCashflow(filas, { texto: "pago" }, { modo: "concepto" }).coincidencias.length, 1);
  // Sin distinguir tildes: "Bonhomía" encuentra "Bonhomia" como coincidencia exacta.
  const bon: DetalleRegistro[] = [{ categoria: "GASTOS_FIJOS", fila: 2, concepto: "Bonhomia", semana: "S01", valor: "€5.00" }];
  const rb = consultarCashflow(bon, { texto: "bonhomía" }, { modo: "concepto" });
  assert.equal(rb.coincidencias.length, 1);
  assert.equal(rb.aproximado, false);
});

test("semana: 'S38', 's38', '38', 'semana 38', 'S-38', 's.38' y 'S3'/'S03' son equivalentes", () => {
  for (const s of ["s38", "38", "semana 38", "S-38", "s.38", " S38 "]) assert.equal(normalizarSemana(s), "S38", s);
  assert.equal(normalizarSemana("S3"), "S03");
  assert.deepEqual(nombres(q({ semana: "38", categoria: "impuestos por pagar" })), ["MOD 303 EWORKS Q4 - 25", "Providencia de apremio"]);
});

test("categoría desconocida: se avisa y se busca como nombre; con texto se ignora y se dice", () => {
  const sola = q({ categoria: "apremio" });
  assert.equal(sola.categoriaNoReconocida, "apremio");
  assert.deepEqual(nombres(sola), ["Providencia de apremio"]);
  assert.match(formatearResultadoCashflow(sola, { categoria: "apremio" }), /se buscó como nombre/);

  const conTexto = { categoria: "zona rara", texto: "apremio" };
  const t = q(conTexto);
  assert.deepEqual(nombres(t), ["Providencia de apremio"]);
  assert.match(formatearResultadoCashflow(t, conTexto), /se ignoró y se buscó solo por el texto/);
});

test("sin resultados: enumera los intentos REALES y la cobertura, y prohíbe concluir que 'no está'", () => {
  const consulta: ConsultaCashflow = { texto: "qwertyzz", empresa: "EWORKS", semana: "S38" };
  const r = q(consulta);
  assert.equal(r.coincidencias.length, 0);
  const texto = formatearResultadoCashflow(r, consulta);
  assert.match(texto, /No se encontraron movimientos para: texto «qwertyzz», empresa EWORKS, semana S38/);
  assert.match(texto, /1\) con todos los criterios \(nombre, sinónimos\): 0 filas/);
  assert.doesNotMatch(texto.split("\n").find((l) => l.startsWith("Se probó")) ?? "", /importe/, "no afirma haber probado el importe si no se pidió");
  assert.match(texto, /sin exigir la semana ni la empresa/);
  assert.match(texto, /16 movimientos leídos/);
  assert.match(texto, /Impuestos por Pagar: 8/);
  assert.match(texto, /Gastos Consultores Mes Actual: 0 \(vacía\)/);
  assert.match(texto, /No afirmes que el pago no está/);

  // Una consulta solo de semana no puede afirmar que se probó por nombre o importe.
  const soloSemana = q({ semana: "S99" });
  assert.equal(soloSemana.intentos.length, 1);
  assert.doesNotMatch(formatearResultadoCashflow(soloSemana, { semana: "S99" }), /nombre.*sinónimos/);
});

test("lectura: hoja vacía = fallo de lectura (no 'no hay'); secciones no localizadas y filas ilegibles se avisan siempre que importan", () => {
  const vacia = consultarCashflow([], { texto: "apremio" });
  assert.match(formatearResultadoCashflow(vacia, { texto: "apremio" }), /devolvió 0 movimientos.*NO una ausencia del dato/s);

  const severo = { bloque: "IMPUESTOS_POR_PAGAR", detalle: "cashflowLayout no pudo localizar de forma inequívoca el título de IMPUESTOS_POR_PAGAR" };
  const fila = { bloque: "IMPUESTOS_POR_PAGAR", detalle: "La fila 36 de IMPUESTOS_POR_PAGAR tiene concepto pero no importe; WOBI la excluyó." };
  const otra = { bloque: "INGRESOS", detalle: "La fila 26 de INGRESOS tiene concepto pero no importe; WOBI la excluyó." };

  const consultaVacia: ConsultaCashflow = { texto: "qwertyzz" };
  const rVacia = q(consultaVacia);
  const tVacia = formatearResultadoCashflow(rVacia, consultaVacia, { problemasLectura: [severo, fila, otra] });
  assert.match(tVacia, /LECTURA INCOMPLETA DE LA HOJA/);
  assert.match(tVacia, /Avisos de lectura de la hoja/);
  assert.match(tVacia, /La fila 36 de IMPUESTOS_POR_PAGAR/);
  assert.match(tVacia, /Impuestos por Pagar: 8/);

  // Con resultado: las filas ilegibles solo se citan si son de las secciones implicadas.
  const consulta: ConsultaCashflow = { texto: "apremio" };
  const t = formatearResultadoCashflow(q(consulta), consulta, { problemasLectura: [fila, otra] });
  assert.match(t, /La fila 36 de IMPUESTOS_POR_PAGAR/);
  assert.doesNotMatch(t, /La fila 26 de INGRESOS/);

  const sinLocalizar = consultarCashflow(hoja().filter((r) => r.categoria !== "IMPUESTOS_POR_PAGAR"), { texto: "apremio" });
  assert.match(formatearResultadoCashflow(sinLocalizar, { texto: "apremio" }, { problemasLectura: [severo] }), /Impuestos por Pagar: 0 \(NO SE PUDO LOCALIZAR\)/);
});

test("salida: tope de 40 líneas con total y resumen por sección; cada línea con categoría, empresa, semana, valor, año y porqué", () => {
  const muchas: DetalleRegistro[] = Array.from({ length: 45 }, (_, i) => ({ categoria: "GASTOS_FIJOS", fila: i + 1, concepto: `Servicio ${i + 1}`, semana: "S40", valor: "€10.00" }));
  const t = formatearResultadoCashflow(consultarCashflow(muchas, { categoria: "gastos fijos" }), { categoria: "gastos fijos" });
  assert.match(t, /Mostrando 40 de 45 \(Gastos Fijos: 45\)/);
  assert.equal(t.split("\n").filter((l) => l.startsWith("[GASTOS_FIJOS]")).length, 40);

  const consulta: ConsultaCashflow = { empresa: "EWORKS", texto: "apremio" };
  const linea = formatearResultadoCashflow(q(consulta), consulta);
  assert.match(linea, /\[IMPUESTOS_POR_PAGAR\] \[sin empresa\] Providencia de apremio — S38 — €747\.31 · año 2026 ⟵ el nombre contiene «apremio»/);
  assert.match(linea, /1 fila\(s\) figuran «sin empresa»/);
  assert.match(linea, /no lo afirmes/);
});

test("entrada de la herramienta: nada se descarta en silencio", () => {
  assert.match(parsearEntradaConsulta({ empresa: "Footprint", contraparte: "Footprint" }).rechazo ?? "", /Footprint NO tiene cashflow/);
  assert.equal(parsearEntradaConsulta({ empresa: "eworks" }).consulta?.empresa, "EWORKS");
  assert.equal(parsearEntradaConsulta({ empresa: "EWORKS S.L." }).consulta?.empresa, "EWORKS");
  assert.equal(parsearEntradaConsulta({ empresa: "WOBA" }).consulta?.empresa, "WOBA");

  const invalida = parsearEntradaConsulta({ empresa: "Acme", contraparte: "apremio" });
  assert.equal(invalida.consulta?.empresa, undefined);
  assert.match(invalida.ignorados.join(), /empresa «Acme»/);
  assert.equal(invalida.consulta?.texto, "apremio");

  const soloMalo = parsearEntradaConsulta({ valor: "n/a" });
  assert.match(soloMalo.rechazo ?? "", /No se aplicó ningún filtro válido.*no vuelques toda la hoja/);
  assert.equal(parsearEntradaConsulta({ valor: 0, contraparte: "x" }).ignorados.length, 1);
  assert.equal(parsearEntradaConsulta({ valor: "747,31" }).consulta?.valor, 747.31);
  assert.equal(parsearEntradaConsulta({ valor: -137.62 }).consulta?.valor, 137.62);
  assert.match(parsearEntradaConsulta({ valor: 747, tolerancia_eur: -1 }).ignorados.join(), /tolerancia_eur/);
  assert.equal(parsearEntradaConsulta({ semana: "semana 38" }).consulta?.semana, "S38");
  assert.match(parsearEntradaConsulta({ semana: "abc", contraparte: "x" }).ignorados.join(), /semana «abc»/);
  assert.equal(parsearEntradaConsulta({ valor: Number.NaN, contraparte: "x" }).ignorados.length, 1);

  const texto = formatearResultadoCashflow(q({ texto: "apremio" }), { texto: "apremio" }, { ignorados: ["empresa «Acme» (solo WOBA o EWORKS)"] });
  assert.match(texto, /Se ignoraron parámetros no válidos.*empresa «Acme»/);
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

test("sin pistas de contenido (solo semana/empresa) lista sin relajar nada", () => {
  const r = q({ semana: "S41" });
  assert.deepEqual(nombres(r).sort(), ["MOD 200 205 EWORKS", "Sanción AEAT", "Telefonica"].sort());
  assert.equal(r.filtrosRelajados.length, 0);
  assert.equal(q({ semana: "S99" }).coincidencias.length, 0);
});

const fila = (categoria: DetalleRegistro["categoria"], concepto: string, semana: string, valor: string, extra: Partial<DetalleRegistro> = {}): DetalleRegistro => ({
  categoria, fila: Math.floor(Math.random() * 1e6), concepto, semana, valor, ...extra,
});

test("un parecido débil NO detiene la búsqueda: si relajando una pista aparece la EXACTA, se devuelve y los parecidos la acompañan", () => {
  const filas = [fila("GASTOS_FIJOS", "Alquiler oficina Madrid", "S10", "€1,000.00"), fila("GASTOS_FIJOS", "Alquiler local Barcelona", "S20", "€900.00")];
  const semana = consultarCashflow(filas, { texto: "Alquiler oficina", semana: "S20" });
  assert.deepEqual(semana.filtrosRelajados, ["semana"]);
  assert.equal(semana.coincidencias[0].registro.concepto, "Alquiler oficina Madrid", "la exacta primero");
  assert.equal(semana.coincidencias[0].calidad, "exacta");
  assert.ok(semana.coincidencias.some((c) => c.registro.concepto === "Alquiler local Barcelona"), "el parecido de esa semana también se cita");

  const importe = consultarCashflow(filas, { texto: "Alquiler oficina", valor: 900 });
  assert.equal(importe.coincidencias[0].registro.concepto, "Alquiler oficina Madrid");
  assert.deepEqual(importe.filtrosRelajados, ["valor"]);

  // Sin exacta en ningún intento, el parecido débil sí se devuelve (aproximado y sin relajar nada).
  const solo = consultarCashflow([filas[1]], { texto: "Alquiler oficina", semana: "S20" });
  assert.equal(solo.aproximado, true);
  assert.deepEqual(solo.filtrosRelajados, []);
});

test("menos pistas quitadas primero: quitar solo la semana antes que semana+empresa", () => {
  const r = q({ texto: "apremio", empresa: "EWORKS", semana: "S99" });
  assert.deepEqual(r.filtrosRelajados, ["semana"]);
  assert.deepEqual(nombres(r), ["Providencia de apremio"]);
});

test("apartadas por empresa: se calculan sobre el intento ganador (sinónimos incluidos), sin duplicados ni obsoletas", () => {
  // Empresa relajada: nada queda 'apartado' (se muestra).
  assert.deepEqual(q({ texto: "MOD 115", empresa: "EWORKS" }).apartadasPorEmpresa, []);
  // Semana relajada: se cuentan las de la otra empresa de TODAS las semanas, cada una una vez.
  const mod303 = q({ texto: "MOD 303", empresa: "EWORKS", semana: "S30" });
  assert.deepEqual(mod303.filtrosRelajados, ["semana"]);
  assert.deepEqual(mod303.apartadasPorEmpresa.map((a) => a.nombre).sort(), ["MOD 303 Q3 WOBA 2024", "MOD 303 WOBA"]);
  // Por sinónimo: 'Hacienda' con empresa=EWORKS aparta también los MOD de WOBA.
  const hacienda = q({ texto: "Hacienda", empresa: "EWORKS" });
  const apartadas = hacienda.apartadasPorEmpresa.map((a) => a.nombre);
  assert.ok(apartadas.includes("MOD 115 WOBA Q2") && apartadas.includes("MOD 111 WOBA Q2"), apartadas.join());
  assert.equal(new Set(apartadas).size, apartadas.length, "sin duplicados");
});

test("un sinónimo real promueve la fila que antes solo era un parecido débil (Seguridad social ≈ seg social)", () => {
  const filas = [fila("GASTOS_FIJOS", "Seguridad Social autonomos", "S40", "€300.00"), fila("GASTOS_FIJOS", "Impuestos seg social", "S40", "€12,000.00")];
  const r = consultarCashflow(filas, { texto: "Seguridad Social" });
  assert.deepEqual(nombres(r), ["Seguridad Social autonomos", "Impuestos seg social"]);
  assert.equal(r.coincidencias[1].calidad, "aproximada");
  assert.match(r.coincidencias[1].motivos.join(), /sinónimo/);
});

test("'impuestos' ofrece la sección entera aunque una fila solo case por palabras parecidas (Impuesto de sociedades)", () => {
  const filas = [...hoja(), impuesto(40, "Impuesto de sociedades", "S45", "€5,000.00")];
  const r = consultarCashflow(filas, { texto: "impuestos" });
  assert.ok(nombres(r).includes("Impuesto de sociedades"));
  assert.ok(nombres(r).includes("Providencia de apremio"));
});

test("palabras genéricas del título ('proyectos', 'otros', 'actual') NO vuelcan tablas enteras", () => {
  const filas = [...Array.from({ length: 30 }, (_, i) => fila("PAGOS_PROYECTOS", `Cliente ${i}`, "S40", "€10.00")), fila("GASTOS_FIJOS", "Material proyectos vario", "S40", "€5.00")];
  assert.deepEqual(nombres(consultarCashflow(filas, { texto: "proyectos" })), ["Material proyectos vario"]);
  assert.equal(consultarCashflow(filas, { texto: "otros" }).coincidencias.length, 0);
});

test("nombre + importe juntos en todos los formatos; fechas, porcentajes y versiones NO se parten", () => {
  const filas = [
    fila("IMPUESTOS_POR_PAGAR", "Sanción AEAT", "S41", "€137.62"),
    fila("IMPUESTOS_POR_PAGAR", "Sanción tráfico", "S41", "€200.00"),
    fila("APLAZAMIENTO_IMPUESTOS", "MOD 200 205 EWORKS", "S41", "€1,186.00"),
    fila("GASTOS_FIJOS", "Fee 1,50 meses", "S01", "€10.00"),
    fila("GASTOS_FIJOS", "Pago 12.05.2025", "S02", "€11.00"),
    fila("GASTOS_FIJOS", "IVA 21,00%", "S03", "€12.00"),
  ];
  for (const texto of ["Sanción AEAT 137,62", "Sanción AEAT 137,62€", "Sanción AEAT €137.62", "Sanción AEAT 137,62 €", "Sanción AEAT 137,62 euros"]) {
    const r = consultarCashflow(filas, { texto });
    assert.deepEqual(r.coincidencias.map((c) => c.registro.concepto), ["Sanción AEAT"], texto);
    assert.equal(r.aproximado, false, texto);
  }
  for (const texto of ["MOD 200 205 EWORKS 1186,00", "MOD 200 205 EWORKS 1.186,00", "MOD 200 205 EWORKS 1186 €"]) {
    assert.deepEqual(consultarCashflow(filas, { texto }).coincidencias.map((c) => c.registro.concepto), ["MOD 200 205 EWORKS"], texto);
  }
  for (const texto of ["Pago 12.05.2025", "IVA 21,00%"]) {
    const r = consultarCashflow(filas, { texto });
    assert.equal(r.consultaEfectiva.texto, texto, `no se reescribe: ${texto}`);
    assert.equal(r.coincidencias[0]?.registro.concepto, texto);
  }
  assert.equal(consultarCashflow(filas, { texto: "Fee 1,50 meses" }).coincidencias[0]?.registro.concepto, "Fee 1,50 meses", "'1,50' se separa como importe, pero se vuelve al texto original si no casa");
  assert.equal(consultarCashflow(filas, { texto: "MOD 200 205 EWORKS" }).consultaEfectiva.valor, undefined, "MOD 200 205 no es un importe");
});

test("con nombre+importe separados, si el importe no casa se vuelve al texto original antes de relajar el nombre", () => {
  const filas = [fila("GASTOS_FIJOS", "Fee 1,50 meses", "S01", "€10.00")];
  const r = consultarCashflow(filas, { texto: "Fee 1,50 meses" });
  assert.deepEqual(nombres(r), ["Fee 1,50 meses"]);
  assert.equal(r.aproximado, false);
});

test("las secciones reconocidas solo se citan si se aplicaron; al relajar el nombre queda solo la sección y se marca aproximada", () => {
  const relajada = q({ texto: "apremio", categoria: "gastos fijos" });
  assert.deepEqual(relajada.filtrosRelajados, ["categoria"]);
  assert.deepEqual(relajada.categoriasReconocidas, []);
  assert.doesNotMatch(formatearResultadoCashflow(relajada, { texto: "apremio", categoria: "gastos fijos" }), /Sección\(es\)/);

  const soloSeccion = q({ texto: "algo que no existe", categoria: "gastos fijos" });
  assert.deepEqual(soloSeccion.filtrosRelajados, ["texto"]);
  assert.equal(soloSeccion.aproximado, true);
  assert.match(soloSeccion.coincidencias[0].motivos.join(), /solo pertenece a la sección/);
});

test("la etiqueta de empresa es la misma con o sin filtro: '[EWORKS por el nombre]'", () => {
  const sin = formatearResultadoCashflow(q({ texto: "MOD 303 EWORKS Q2" }), { texto: "MOD 303 EWORKS Q2" });
  const con = formatearResultadoCashflow(q({ texto: "MOD 303 EWORKS Q2", empresa: "EWORKS" }), { texto: "MOD 303 EWORKS Q2", empresa: "EWORKS" });
  for (const t of [sin, con]) assert.match(t, /\[EWORKS por el nombre\] MOD 303 EWORKS Q2/);
  assert.doesNotMatch(sin, /figuran «sin empresa»/);
});

test("una celda de importe vacía o ilegible NO es 0 €: no casa con importes pequeños", () => {
  const filas = [fila("IMPUESTOS_POR_PAGAR", "Sin importe aún", "S01", ""), fila("IMPUESTOS_POR_PAGAR", "Pendiente confirmar", "S02", "pendiente")];
  assert.equal(consultarCashflow(filas, { valor: 0.5 }).coincidencias.length, 0);
  assert.equal(consultarCashflow(filas, { valor: 1 }).coincidencias.length, 0);
});

test("modo concepto: una exacta oculta las parecidas (de eso depende la SUMA de vencimientos) y no relaja ni con empresa", () => {
  const filas = [fila("GASTOS_FIJOS", "Cuotas préstamo", "S01", "€100.00"), fila("GASTOS_FIJOS", "Cuota autónomos", "S01", "€50.00")];
  assert.deepEqual(nombres(consultarCashflow(filas, { texto: "cuotas" }, { modo: "concepto" })), ["Cuotas préstamo"]);
  const sinRelajar = consultarCashflow(hoja(), { texto: "MOD 115", empresa: "EWORKS" }, { modo: "concepto" });
  assert.deepEqual(sinRelajar.filtrosRelajados, []);
  assert.equal(sinRelajar.coincidencias.length, 0, "en modo concepto nunca suma dinero de la otra empresa");
});

test("entrada rara del modelo: tipos inesperados se enumeran, números valen como texto, nada revienta ni tarda", () => {
  assert.equal(parsearEntradaConsulta({ semana: 38 }).consulta?.semana, "S38");
  assert.equal(parsearEntradaConsulta({ contraparte: 747.31 }).consulta?.texto, "747.31");
  const lista = parsearEntradaConsulta({ contraparte: ["apremio"], semana: "S38" });
  assert.match(lista.ignorados.join(), /contraparte \(se esperaba texto, llegó una lista\)/);
  assert.equal(parsearEntradaConsulta({ empresa: ["WOBA"] }).rechazo === undefined, false, "solo una pista inválida → se pide aclaración");
  assert.match(parsearEntradaConsulta(null).rechazo ?? "", /^$|.*/);
  assert.deepEqual(parsearEntradaConsulta(undefined).ignorados, []);
  const larga = parsearEntradaConsulta({ contraparte: "a".repeat(5000) });
  assert.equal(larga.consulta?.texto?.length, 200);
  assert.match(larga.ignorados.join(), /demasiado largo/);
  assert.match(parsearEntradaConsulta({ valor: 0.004, contraparte: "x" }).ignorados.join(), /al menos 0,01/);
  assert.match(parsearEntradaConsulta({ valor: "1e3" }).rechazo ?? "", /No se aplicó ningún filtro válido/);
  const t0 = Date.now();
  importeDeTexto("1" + " ".repeat(200_000) + "x");
  consultarCashflow(hoja(), { texto: "palabra ".repeat(500) });
  assert.ok(Date.now() - t0 < 1500, "sin backtracking cuadrático");
});
