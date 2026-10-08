import test from "node:test";
import assert from "node:assert/strict";
import { equivalenteCuadraConTasa } from "./equivalenteCoherente";

const TASA_MXN_EUR = 0.0494; // ≈ 20,2 MXN por EUR

test("caso real: 4.036,92 MXN → 204,65 € cuadra, 174,60 € no (era de otra reserva)", () => {
  assert.equal(equivalenteCuadraConTasa({ monto: 4036.92, equivalente: 204.65, tasa: TASA_MXN_EUR }), true);
  assert.equal(equivalenteCuadraConTasa({ monto: 4036.92, equivalente: 174.6, tasa: TASA_MXN_EUR }), false);
});

test("un spread normal de tarjeta (hasta un 4-5 %) se acepta", () => {
  assert.equal(equivalenteCuadraConTasa({ monto: 100, equivalente: 100 * 0.9 * 1.04, tasa: 0.9 }), true);
  assert.equal(equivalenteCuadraConTasa({ monto: 100, equivalente: 100 * 0.9 * 0.96, tasa: 0.9 }), true);
});

test("ejemplo de un viaje en Bogotá: 44.200 COP cobrados como 11,98 € con tasa ≈ 0,000271 cuadra", () => {
  assert.equal(equivalenteCuadraConTasa({ monto: 44200, equivalente: 11.98, tasa: 0.000271 }), true);
});

test("más del 8 % de diferencia se rechaza", () => {
  assert.equal(equivalenteCuadraConTasa({ monto: 100, equivalente: 100 * 0.9 * 1.12, tasa: 0.9 }), false);
  assert.equal(equivalenteCuadraConTasa({ monto: 100, equivalente: 100 * 0.9 * 0.88, tasa: 0.9 }), false);
});

test("sin tasa o con datos inválidos no se juzga: el equivalente se conserva", () => {
  assert.equal(equivalenteCuadraConTasa({ monto: 100, equivalente: 5, tasa: undefined }), true);
  assert.equal(equivalenteCuadraConTasa({ monto: 100, equivalente: 5, tasa: Number.NaN }), true);
  assert.equal(equivalenteCuadraConTasa({ monto: 0, equivalente: 5, tasa: 0.9 }), true);
  assert.equal(equivalenteCuadraConTasa({ monto: 100, equivalente: 0, tasa: 0.9 }), true);
});
