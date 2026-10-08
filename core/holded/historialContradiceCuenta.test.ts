import test from "node:test";
import assert from "node:assert/strict";
import { historialContradiceCuenta } from "./write";

const lineas = (cuenta: string, n: number) => Array.from({ length: n }, () => ({ account: cuenta }));

test("caso Luarca: 68 líneas del proveedor, 1 en la cuenta de viaje → el historial contradice «viaje»", () => {
  const historial = [...lineas("arrendamiento-a", 45), ...lineas("arrendamiento-b", 14), ...lineas("arrendamiento-c", 8), ...lineas("viaje", 1)];
  assert.equal(historialContradiceCuenta(historial, "viaje"), true);
});

test("un proveedor que ya va a viaje no contradice «viaje»", () => {
  assert.equal(historialContradiceCuenta([...lineas("viaje", 9), ...lineas("otros", 1)], "viaje"), false);
});

test("historial corto (menos de 3 líneas) no decide: la regla de viaje se mantiene", () => {
  assert.equal(historialContradiceCuenta(lineas("arrendamiento", 2), "viaje"), false);
  assert.equal(historialContradiceCuenta([], "viaje"), false);
});

test("historial repartido a partes iguales entre viaje y otra cuenta no contradice", () => {
  assert.equal(historialContradiceCuenta([...lineas("viaje", 5), ...lineas("otros", 5)], "viaje"), false);
});

test("justo en el 20 % sí contradice; por encima, no", () => {
  assert.equal(historialContradiceCuenta([...lineas("viaje", 2), ...lineas("otros", 8)], "viaje"), true);
  assert.equal(historialContradiceCuenta([...lineas("viaje", 3), ...lineas("otros", 7)], "viaje"), false);
});
