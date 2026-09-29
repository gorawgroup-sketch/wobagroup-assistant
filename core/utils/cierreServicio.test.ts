import assert from "node:assert/strict";
import test from "node:test";
import { alSolicitarCierre, cierreSolicitado, reiniciarCierreParaPruebas, solicitarCierre } from "./cierreServicio";

test("la señal de cierre se activa una sola vez y avisa a los oyentes registrados", () => {
  reiniciarCierreParaPruebas();
  let avisos = 0;
  const baja = alSolicitarCierre(() => { avisos++; });
  assert.equal(cierreSolicitado(), false);
  solicitarCierre();
  solicitarCierre();
  assert.equal(cierreSolicitado(), true);
  assert.equal(avisos, 1);
  baja();
  reiniciarCierreParaPruebas();
  assert.equal(cierreSolicitado(), false);
});

test("un oyente que falla no impide avisar a los demás ni activar la señal", () => {
  reiniciarCierreParaPruebas();
  let segundo = false;
  alSolicitarCierre(() => { throw new Error("boom"); });
  alSolicitarCierre(() => { segundo = true; });
  solicitarCierre();
  assert.equal(segundo, true);
  assert.equal(cierreSolicitado(), true);
  reiniciarCierreParaPruebas();
});
