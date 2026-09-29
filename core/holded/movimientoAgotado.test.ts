import assert from "node:assert/strict";
import test from "node:test";
import { movimientoAgotadoSalvoRedondeo } from "./write";

test("un cargo parcial al que solo le quedan céntimos de redondeo ya está usado", () => {
  assert.equal(movimientoAgotadoSalvoRedondeo({ amount: "-11.17", reconciled_amount: "-11.15" }), true);
  assert.equal(movimientoAgotadoSalvoRedondeo({ amount: "-35.62", reconciled_amount: "-35.59" }), true);
});

test("un cargo libre o con resto real sigue disponible", () => {
  assert.equal(movimientoAgotadoSalvoRedondeo({ amount: "-11.17", reconciled_amount: "0.00" }), false);
  assert.equal(movimientoAgotadoSalvoRedondeo({ amount: "-11.17" }), false);
  assert.equal(movimientoAgotadoSalvoRedondeo({ amount: "-500.00", reconciled_amount: "-200.00" }), false);
});
