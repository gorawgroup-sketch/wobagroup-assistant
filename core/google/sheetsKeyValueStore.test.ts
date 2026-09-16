import assert from "node:assert/strict";
import test from "node:test";
import { filaDesdeRangoActualizado } from "./sheetsKeyValueStore";

test("extrae la fila confirmada por values.append", () => {
  assert.equal(filaDesdeRangoActualizado("_conciliaciones_holded_durables!A42:L42"), 42);
  assert.equal(filaDesdeRangoActualizado("'ledger con espacios'!A7:L7"), 7);
});

test("rechaza rangos de append incompletos o sin fila", () => {
  assert.equal(Number.isNaN(filaDesdeRangoActualizado("")), true);
  assert.equal(Number.isNaN(filaDesdeRangoActualizado("Hoja!A:L")), true);
});
