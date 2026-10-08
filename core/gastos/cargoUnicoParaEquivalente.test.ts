import test from "node:test";
import assert from "node:assert/strict";
import { cargoUnicoParaEquivalente, coincideConLaReferencia } from "./movimientoMultimoneda";

type C = { id: string; monto: number; montoReferencia?: number; compatibilidad?: "por_confirmar" | "aprendido" };

test("un solo cargo seguro se toma como el importe real", () => {
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "a", monto: 1 }])?.id, "a");
});

test("un único cargo por confirmar (nombre distinto) sirve para armar la propuesta — caso Merpago*eugeniodiaz", () => {
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "mp", monto: 8.92, compatibilidad: "por_confirmar" }])?.id, "mp");
});

test("un cargo seguro gana a uno por confirmar", () => {
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "dudoso", monto: 1, compatibilidad: "por_confirmar" }, { id: "seguro", monto: 1 }])?.id, "seguro");
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "dudoso", monto: 1, compatibilidad: "por_confirmar" }, { id: "conocido", monto: 1, compatibilidad: "aprendido" }])?.id, "conocido");
});

test("ambiguo o vacío no elige nada", () => {
  assert.equal(cargoUnicoParaEquivalente<C>([]), undefined);
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "a", monto: 1 }, { id: "b", monto: 1 }]), undefined);
  assert.equal(cargoUnicoParaEquivalente<C>([{ id: "a", monto: 1, compatibilidad: "por_confirmar" }, { id: "b", monto: 1, compatibilidad: "por_confirmar" }]), undefined);
});

test("caso real Taxi 129,94 MXN: cinco cargos parecidos, uno solo coincide al céntimo con la tasa (6,43 €)", () => {
  const ref = 6.43;
  const cargos: C[] = [
    { id: "dlo-6.43", monto: -6.43, montoReferencia: ref },
    { id: "pending-6.34", monto: -6.34, montoReferencia: ref, compatibilidad: "por_confirmar" },
    { id: "dlo-5.99", monto: -5.99, montoReferencia: ref },
    { id: "dlo-5.94", monto: -5.94, montoReferencia: ref },
    { id: "pending-5.65", monto: -5.65, montoReferencia: ref, compatibilidad: "por_confirmar" },
  ];
  assert.equal(cargoUnicoParaEquivalente(cargos)?.id, "dlo-6.43");
});

test("dos cargos que coinciden al céntimo (dos viajes del mismo importe) no se adivinan", () => {
  const cargos: C[] = [{ id: "a", monto: -6.43, montoReferencia: 6.43 }, { id: "b", monto: -6.43, montoReferencia: 6.43 }, { id: "c", monto: -5.99, montoReferencia: 6.43 }];
  assert.equal(cargoUnicoParaEquivalente(cargos), undefined);
});

test("sin ningún cargo exacto con la tasa (spread de la tarjeta) sigue sin elegir", () => {
  const cargos: C[] = [{ id: "a", monto: -6.2, montoReferencia: 6.43 }, { id: "b", monto: -6.6, montoReferencia: 6.43 }];
  assert.equal(cargoUnicoParaEquivalente(cargos), undefined);
});

test("coincideConLaReferencia: tolerancia de 2 céntimos o 0,5 %, y sin referencia no coincide", () => {
  assert.equal(coincideConLaReferencia({ monto: -6.44, montoReferencia: 6.43 }), true);
  assert.equal(coincideConLaReferencia({ monto: -6.34, montoReferencia: 6.43 }), false);
  assert.equal(coincideConLaReferencia({ monto: -1000.0, montoReferencia: 1004.5 }), true);
  assert.equal(coincideConLaReferencia({ monto: -1000.0, montoReferencia: 1006 }), false);
  assert.equal(coincideConLaReferencia({ monto: -6.43 }), false);
});
