import assert from "node:assert/strict";
import test from "node:test";
import { cargoCorrespondeMejorAOtroRecibo, MAX_RECIBOS_REPARTO } from "./repartoOptimo";

const U = undefined;

test("sin competidores el cargo se conserva", () => {
  assert.equal(cargoCorrespondeMejorAOtroRecibo([[0.02, U]], 0), false);
});

test("caso hotel MOME: cada cargo solo cuadra con su recibo; no se desplaza ninguno", () => {
  // Cargos: [EUR 120,09, USD 112,87]. Recibo 0 = MOME (EUR 1,8 %), recibo 1 = otro hotel (USD 2,5 %).
  const matriz = [[0.018, U], [U, 0.025]];
  assert.equal(cargoCorrespondeMejorAOtroRecibo(matriz, 0), false);
});

test("un cargo que encaja claramente mejor con otro recibo se retira de este", () => {
  // Ambos recibos admiten el cargo 0; el competidor lo ajusta al 0,2 % y este al 2,5 %.
  assert.equal(cargoCorrespondeMejorAOtroRecibo([[0.025], [0.002]], 0), true);
});

test("si este recibo encaja mejor, conserva el cargo", () => {
  assert.equal(cargoCorrespondeMejorAOtroRecibo([[0.002], [0.025]], 0), false);
});

test("empate o diferencia menor al margen: se conserva", () => {
  assert.equal(cargoCorrespondeMejorAOtroRecibo([[0.01], [0.01]], 0), false);
  assert.equal(cargoCorrespondeMejorAOtroRecibo([[0.012], [0.01]], 0), false);
});

test("reparto cruzado: dos cargos y dos recibos que admiten ambos; gana la combinación de menor desviación total", () => {
  // Recibo0: c0 1 %, c1 2 %. Recibo1: c0 0,5 %, c1 3 %. Óptimo global: R0→c1 (2) + R1→c0 (0,5) = 2,5 < R0→c0 + R1→c1 = 4.
  const matriz = [[0.01, 0.02], [0.005, 0.03]];
  assert.equal(cargoCorrespondeMejorAOtroRecibo(matriz, 0), true, "c0 es mejor para el otro recibo");
  assert.equal(cargoCorrespondeMejorAOtroRecibo(matriz, 1), false, "c1 sí es de este recibo");
});

test("no deja sin cargo a un recibo que solo admite uno: maximiza coincidencias antes que desviación", () => {
  // Recibo0 admite c0 y c1; recibo1 solo c0 (peor ajuste). Dar c0 a recibo0 deja a recibo1 sin nada → 1 coincidencia
  // frente a 2: c0 va a recibo1 y recibo0 se queda con c1.
  assert.equal(cargoCorrespondeMejorAOtroRecibo([[0.001, 0.02], [0.02, undefined]], 0), true);
});

test("un cargo no admisible para este recibo nunca se «desplaza» (no hay nada que retirar)", () => {
  assert.equal(cargoCorrespondeMejorAOtroRecibo([[U], [0.01]], 0), false);
});

test("por encima del tamaño máximo se conserva el comportamiento anterior", () => {
  const filas = Array.from({ length: MAX_RECIBOS_REPARTO + 1 }, (_, i) => [i === 0 ? 0.025 : 0.001]);
  assert.equal(cargoCorrespondeMejorAOtroRecibo(filas, 0), false);
});

test("un cargo peor para este recibo que otra alternativa suya, pero que nadie más necesita, se conserva", () => {
  // Cargos [c0, c1, propio del competidor]. Este recibo: c0 2,9 %, c1 1,1 %. Competidor: c0 0,2 %, c1 1,5 %, propio 0 %.
  const matriz = [[0.029, 0.011, undefined], [0.002, 0.015, 0]];
  assert.equal(cargoCorrespondeMejorAOtroRecibo(matriz, 0), false, "el competidor se queda con su propio cargo");
});
