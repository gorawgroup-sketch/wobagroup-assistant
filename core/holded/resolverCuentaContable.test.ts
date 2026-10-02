import assert from "node:assert/strict";
import test from "node:test";
import { resolverCuentaContable } from "./resolverCuentaContable";

const plan = [
  { id: "a", number: 62900000, name: "Otros servicios", group: "g" },
  { id: "b", number: 62900001, name: "Gastos de Viaje", group: "g" },
  { id: "c", number: 62900002, name: "Gastos de Viaje - Alojamiento", group: "g" },
  { id: "d", number: 62900003, name: "Otros servicios digitales", group: "g" },
];

test("resuelve por número exacto y por nombre exacto sin tildes ni mayúsculas", () => {
  assert.deepEqual(resolverCuentaContable(plan, "62900000"), { ok: true, cuenta: plan[0] });
  assert.deepEqual(resolverCuentaContable(plan, "  otros SERVICIOS "), { ok: true, cuenta: plan[0] });
});
test("el nombre exacto gana sobre coincidencias parciales", () => {
  assert.equal((resolverCuentaContable(plan, "gastos de viaje") as { cuenta: { id: string } }).cuenta.id, "b");
});
test("nunca adivina: parcial ambigua, inexistente o vacío devuelven el motivo", () => {
  const ambigua = resolverCuentaContable(plan, "servicios");
  assert.equal(ambigua.ok, false);
  assert.match((ambigua as { motivo: string }).motivo, /varias cuentas/);
  assert.equal(resolverCuentaContable(plan, "inventada").ok, false);
  assert.equal(resolverCuentaContable(plan, "99999999").ok, false);
  assert.equal(resolverCuentaContable(plan, "  ").ok, false);
});
