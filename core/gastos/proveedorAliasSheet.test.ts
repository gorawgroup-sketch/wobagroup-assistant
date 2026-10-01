import assert from "node:assert/strict";
import test from "node:test";
import { contactoMasConfirmado, monedaDeAliasCoincide } from "./proveedorAliasSheet";

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

// Caso real (Footprint, 2026-10-01): «CAFE DE SANTA BARBARA S.A.S» y «… SAS» son dos fichas del mismo proveedor en Holded.
test("entre contactos duplicados gana el que el operador ya confirmó, sumando todas las monedas", () => {
  const filas = [
    { contactId: "66d5", vecesConfirmado: 4 },
    { contactId: "66d5", vecesConfirmado: 1 },
  ];
  assert.equal(contactoMasConfirmado(filas, ["66d5", "6859"]), "66d5");
});

test("sin elección previa, o con empate entre los duplicados, no se adivina", () => {
  assert.equal(contactoMasConfirmado([], ["66d5", "6859"]), undefined);
  assert.equal(contactoMasConfirmado([{ contactId: "66d5", vecesConfirmado: 2 }, { contactId: "6859", vecesConfirmado: 2 }], ["66d5", "6859"]), undefined);
});

test("una elección que apunta a un contacto ajeno a los duplicados no cuenta", () => {
  assert.equal(contactoMasConfirmado([{ contactId: "otro", vecesConfirmado: 9 }], ["66d5", "6859"]), undefined);
});
