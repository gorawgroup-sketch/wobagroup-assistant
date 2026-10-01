import assert from "node:assert/strict";
import test from "node:test";
import { describirGastoRegistrado } from "./describirGastoRegistrado";
import { compraPagadaPorCompleto, recuperarConciliacionCompra } from "../holded/recuperarConciliacionCompra";

test("un gasto registrado se describe con proveedor, importe y empresa, no con su código", () => {
  assert.equal(describirGastoRegistrado({ gastoId: "6abcec3fed723f4aa004a1f7", empresa: "WOBA",
    identidad: { proveedor: "Telefónica de España", monto: 32.67, moneda: "EUR", fecha: "2026-10-01" } }),
    "Telefónica de España — 32,67 EUR, 2026-10-01 (WOBA)");
  assert.equal(describirGastoRegistrado({ gastoId: "abc", empresa: "EWORKS" }), "gasto con referencia abc (EWORKS)");
});

const raminatrans = { total: "6892,73", payments_total: "6892,73", payments_pending: "0,00",
  payments_detail: [{ id: "p", amount: "6892,73", date: "2026-09-08", bank_id: "b" }] } as never;

test("caso Raminatrans: una compra pagada entera fuera de Wobi no «requiere revisión»", async () => {
  assert.equal(compraPagadaPorCompleto(raminatrans), true);
  const deps = { leerCompra: async () => raminatrans, listar: async () => [], inspeccionar: async () => { throw new Error("no debe inspeccionar"); } };
  assert.equal(await recuperarConciliacionCompra("EWORKS", "x", deps as never), "pagada_externamente");
});

test("una compra pagada solo en parte, o sin datos fiables, sigue requiriendo revisión", async () => {
  const parcial = { total: "100,00", payments_total: "40,00", payments_pending: "60,00", payments_detail: [{ id: "p", amount: "40,00" }] } as never;
  assert.equal(compraPagadaPorCompleto(parcial), false);
  assert.equal(compraPagadaPorCompleto({ total: "100,00", payments_total: "100,00", payments_pending: "0,00", payments_detail: [] } as never), false);
  assert.equal(compraPagadaPorCompleto({ total: "100,00" } as never), false);
  const deps = { leerCompra: async () => parcial, listar: async () => [], inspeccionar: async () => { throw new Error("x"); } };
  assert.equal(await recuperarConciliacionCompra("EWORKS", "x", deps as never), "revision");
  const sinPagos = { total: "100,00", payments_total: "0,00", payments_pending: "100,00", payments_detail: [] } as never;
  assert.equal(await recuperarConciliacionCompra("EWORKS", "x", { ...deps, leerCompra: async () => sinPagos } as never), "nueva");
});
