import test from "node:test";
import assert from "node:assert/strict";
import { cargoUnicoParaEquivalente } from "./movimientoMultimoneda";

type C = { id: string; compatibilidad?: "por_confirmar" | "aprendido" };

test("un solo cargo seguro se toma como el importe real", () => {
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "a" }])?.id, "a");
});

test("un único cargo por confirmar (nombre distinto) sirve para armar la propuesta — caso Merpago*eugeniodiaz", () => {
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "mp", compatibilidad: "por_confirmar" }])?.id, "mp");
});

test("un cargo seguro gana a uno por confirmar", () => {
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "dudoso", compatibilidad: "por_confirmar" }, { id: "seguro" }])?.id, "seguro");
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "dudoso", compatibilidad: "por_confirmar" }, { id: "conocido", compatibilidad: "aprendido" }])?.id, "conocido");
});

test("ambiguo o vacío no elige nada", () => {
  assert.equal(cargoUnicoParaEquivalente<C>([]), undefined);
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "a" }, { id: "b" }]), undefined);
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "a", compatibilidad: "por_confirmar" }, { id: "b", compatibilidad: "por_confirmar" }]), undefined);
});
