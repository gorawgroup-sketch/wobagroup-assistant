import assert from "node:assert/strict";
import test from "node:test";
import { calcularAhorroNetoCacheUSD, calcularCostoUSD } from "./costTracking";

test("calcula el ahorro neto de caché frente al mismo contexto sin caché", () => {
  // Sonnet 5: lectura de 1M ahorra $1,80; creación de 1M añade $0,50.
  assert.ok(Math.abs(calcularAhorroNetoCacheUSD(1_000_000, 1_000_000, "claude-sonnet-5") - 1.3) < 1e-9);
});

test("una creación sin reutilización se muestra como coste neto, no como ahorro", () => {
  assert.ok(calcularAhorroNetoCacheUSD(100_000, 0, "claude-haiku-4-5") < 0);
});

test("el coste facturado conserva escritura y lectura de caché", () => {
  const costo = calcularCostoUSD({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
  }, "claude-sonnet-5");
  assert.ok(Math.abs(costo - 2.7) < 1e-9);
});
