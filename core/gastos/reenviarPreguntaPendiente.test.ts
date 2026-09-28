import assert from "node:assert/strict";
import test from "node:test";
import { filtrarConciliacionesPorTexto } from "./reenviarPreguntaPendiente";

const pendientes = [
  { descripcionGasto: "AirGSM PTE. LTD. (Airalo) — 12.5 USD", proveedor: "AirGSM PTE. LTD.", monto: 12.5 },
  { descripcionGasto: "Board Riders Inc — 35.62 USD", proveedor: "Board Riders Inc", monto: 35.62 },
  { descripcionGasto: "Uber — 11.17 USD", proveedor: "", monto: 11.17 },
];

test("sin texto devuelve todas las preguntas pendientes", () => {
  assert.equal(filtrarConciliacionesPorTexto(pendientes, "").length, 3);
});

test("resuelve por nombre (parte del proveedor o de la descripción), sin que un proveedor vacío coincida con todo", () => {
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "airalo").map(p => p.monto), [12.5]);
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "Board Riders").map(p => p.monto), [35.62]);
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "uber").map(p => p.monto), [11.17]);
});

test("resuelve por monto con coma o punto y devuelve vacío si nada coincide", () => {
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "12,50").map(p => p.monto), [12.5]);
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "35.62 USD").map(p => p.monto), [35.62]);
  assert.deepEqual(filtrarConciliacionesPorTexto(pendientes, "Cratevo"), []);
});
