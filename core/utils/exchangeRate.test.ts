import assert from "node:assert/strict";
import test from "node:test";
import { verificarConversion } from "./exchangeRate";

test("calcula una diferencia positiva para cargos y notas de crédito", async () => {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ rates: { EUR: 0.9 } }), { status: 200 });

  try {
    const cargo = await verificarConversion(100, "USD", 99, "EUR", "2026-09-10");
    const reembolso = await verificarConversion(-100, "USD", -99, "EUR", "2026-09-10");

    assert.ok(cargo);
    assert.ok(reembolso);
    assert.equal(cargo.montoEsperado, 90);
    assert.equal(reembolso.montoEsperado, -90);
    assert.ok(Math.abs(cargo.diferenciaPct - 10) < 1e-10);
    assert.ok(Math.abs(reembolso.diferenciaPct - 10) < 1e-10);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("un esperado cero solo es correcto cuando el monto registrado también es cero", async () => {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ rates: { EUR: 0.9 } }), { status: 200 });

  try {
    const ambosCero = await verificarConversion(0, "USD", 0, "EUR", "2026-09-10");
    const registradoNoCero = await verificarConversion(0, "USD", 25, "EUR", "2026-09-10");

    assert.equal(ambosCero?.diferenciaPct, 0);
    assert.equal(registradoNoCero?.diferenciaPct, 100);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("no repite un 404 histórico ni lo sustituye por una tasa actual", async () => {
  const original = globalThis.fetch; let llamadas = 0;
  globalThis.fetch = async () => { llamadas++; return new Response("", {status:404}); };
  try {
    const {obtenerTasaCambioHistorica} = await import('./exchangeRate');
    assert.equal(await obtenerTasaCambioHistorica('2026-08-26','COP','EUR'), undefined);
    assert.equal(await obtenerTasaCambioHistorica('2026-08-26','COP','EUR'), undefined);
    assert.equal(llamadas,1, 'COP va directo a la cobertura ampliada (el BCE no lo publica) y el 404 no se repite');
  } finally { globalThis.fetch = original; }
});


test("COP usa directamente la referencia histórica inversa precisa y comparte consultas concurrentes", async () => {
  const original = globalThis.fetch; const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return String(url).includes('/v1/') ? new Response('',{status:404}) :
      Response.json({date:'2026-09-22',base:'EUR',quote:'COP',rate:4000});
  };
  try {
    const {obtenerTasaCambioHistorica} = await import('./exchangeRate');
    const tasas = await Promise.all([obtenerTasaCambioHistorica('2026-09-22','COP','EUR'),obtenerTasaCambioHistorica('2026-09-22','COP','EUR')]);
    assert.equal(urls.length,1);
    assert.match(urls[0], /EUR\/COP\?date=2026-09-22/);
    assert.equal(tasas[0],1/4000); assert.equal(tasas[0],tasas[1]);
    assert.ok(Math.abs(14000*tasas[0]! - 3.50) < .02);
  } finally { globalThis.fetch = original; }
});

test("rechaza tasa futura, par incorrecto y cotización histórica demasiado antigua", async () => {
  const original=globalThis.fetch;
  try {
    const {obtenerTasaCambioHistorica}=await import('./exchangeRate');
    for (const [fecha,data] of [
      ['2026-09-20',{date:'2026-09-21',base:'EUR',quote:'COP',rate:3671}],
      ['2026-09-19',{date:'2026-09-19',base:'USD',quote:'COP',rate:3671}],
      ['2026-09-18',{date:'2026-09-01',base:'EUR',quote:'COP',rate:3671}],
    ] as const) {
      globalThis.fetch=async url=>String(url).includes('/v1/') ? new Response('',{status:404}) : Response.json(data);
      assert.equal(await obtenerTasaCambioHistorica(fecha,'COP','EUR'),undefined);
    }
  } finally {globalThis.fetch=original;}
});

test("una moneda que el BCE no publica (COP) consulta solo la cobertura ampliada, y la tasa obtenida se conserva", async () => {
  const original = globalThis.fetch; const urls: string[] = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return new Response(JSON.stringify({ date: "2026-10-02", base: "EUR", quote: "COP", rate: 3734.57 }), { status: 200 }); };
  try {
    const { obtenerTasaCambioHistorica } = await import("./exchangeRate");
    const tasa = await obtenerTasaCambioHistorica("2026-10-02", "COP", "EUR");
    assert.ok(tasa && Math.abs(tasa - 1 / 3734.57) < 1e-12);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await obtenerTasaCambioHistorica("2026-10-02", "COP", "EUR"), tasa);
    assert.equal(urls.length, 1, "la segunda consulta sale de la caché");
    assert.match(urls[0], /\/v2\/rate\/EUR\/COP\?date=2026-10-02/);
  } finally { globalThis.fetch = original; }
});

test("un timeout aislado en COP se reintenta una vez antes de rendirse", async () => {
  const original = globalThis.fetch; let llamadas = 0;
  globalThis.fetch = async () => {
    llamadas++;
    if (llamadas === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response(JSON.stringify({ date: "2026-10-03", base: "EUR", quote: "COP", rate: 3700 }), { status: 200 });
  };
  try {
    const { obtenerTasaCambioHistorica } = await import("./exchangeRate");
    const tasa = await obtenerTasaCambioHistorica("2026-10-03", "COP", "EUR");
    assert.ok(tasa && Math.abs(tasa - 1 / 3700) < 1e-12);
    assert.equal(llamadas, 2);
  } finally { globalThis.fetch = original; }
});
