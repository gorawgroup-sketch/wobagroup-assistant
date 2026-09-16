import assert from "node:assert/strict";
import test from "node:test";
import { monedaDeAliasCoincide } from "./proveedorAliasSheet";

test("sin moneda esperada, cualquier alias coincide (llamadores que no manejan gastos multi-moneda)", () => {
  assert.equal(monedaDeAliasCoincide("EUR", undefined), true);
  assert.equal(monedaDeAliasCoincide("", undefined), true);
});

test("caso real Carlos (Footprint, Uber, 2026-09-16): un alias confirmado en EUR (España) no coincide con una moneda distinta (Costa Rica)", () => {
  assert.equal(monedaDeAliasCoincide("EUR", "CRC"), false);
});

test("un alias sin moneda guardada (filas de antes de este fix) tampoco coincide con una moneda esperada explícita — se re-confirma una vez, en vez de heredar la moneda equivocada", () => {
  assert.equal(monedaDeAliasCoincide("", "CRC"), false);
  assert.equal(monedaDeAliasCoincide("", "EUR"), false);
});

test("misma moneda, sin importar mayúsculas o espacios, sí coincide", () => {
  assert.equal(monedaDeAliasCoincide("eur", "EUR"), true);
  assert.equal(monedaDeAliasCoincide(" EUR ", "eur"), true);
});
