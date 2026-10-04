import assert from "node:assert/strict";
import test from "node:test";
import { lineaMovimientoSinConciliar } from "./movimientosSinConciliar";

const base = { cuentaId: "65c4e023574025105f053660", movimientoId: "6aba3a36a075165db00fd310", estado: "pending", cuenta: "FTG USD", descripcion: "Metroart Hotel", monto: -451.3, moneda: "USD", equivalenteEur: -401.2, fecha: "2026-09-28" };

test("cada cargo sin conciliar trae sus ids reales, para poder conciliarlo sin inventar nada (caso Metroart)", () => {
  const l = lineaMovimientoSinConciliar(base);
  assert.match(l, /\[FTG USD\] Metroart Hotel — -451\.30 USD \(≈ -401\.20 €\) \(2026-09-28\)/);
  assert.match(l, /accountId=65c4e023574025105f053660 movementId=6aba3a36a075165db00fd310/);
  assert.doesNotMatch(l, /estado=/, "pendiente es el caso normal: no se repite");
});
test("un cargo parcialmente conciliado indica su estado; en EUR no inventa equivalentes; sin id no se imprime un id vacío", () => {
  assert.match(lineaMovimientoSinConciliar({ ...base, estado: "partial" }), /estado=partial/);
  const eur = lineaMovimientoSinConciliar({ ...base, moneda: "EUR", monto: -12.5, equivalenteEur: null, cuenta: "Main EUR" });
  assert.match(eur, /-12\.50 €/); assert.doesNotMatch(eur, /≈/);
  assert.doesNotMatch(lineaMovimientoSinConciliar({ ...base, movimientoId: "" }), /accountId=/);
});
