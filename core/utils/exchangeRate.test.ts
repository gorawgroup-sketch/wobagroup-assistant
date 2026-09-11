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
