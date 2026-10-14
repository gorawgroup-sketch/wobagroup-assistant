import assert from "node:assert/strict";
import test from "node:test";
import { conciliadosCercanosAlComprobante } from "./conciliadosCercanos";

// Caso real 14-10-2026: recibo de Anthropic del 13/10 (21,63 €); conciliados del 07/10 (21,64) y 08/10 (21,63); cargo libre del 13/10 (21,61).
test("un cargo conciliado de otra fecha no es el recibo de un proveedor recurrente", () => {
  const movs = [{ fecha: "2026-10-07", d: "21,64" }, { fecha: "2026-10-08", d: "21,63" }];
  const r = conciliadosCercanosAlComprobante(movs, "2026-10-13");
  assert.deepEqual(r.cercanos, []);
  assert.equal(r.lejanos.length, 2);
});

test("un cargo conciliado del mismo día o del día siguiente sí puede ser este gasto; sin fecha válida no se filtra", () => {
  const movs = [{ fecha: "2026-10-12" }, { fecha: "2026-10-14" }, { fecha: "2026-10-16" }];
  assert.deepEqual(conciliadosCercanosAlComprobante(movs, "2026-10-13").cercanos.map((m) => m.fecha), ["2026-10-12", "2026-10-14"]);
  assert.equal(conciliadosCercanosAlComprobante(movs, "").cercanos.length, 3);
});
