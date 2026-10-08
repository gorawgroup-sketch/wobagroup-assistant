import assert from "node:assert/strict";
import test from "node:test";
import { buscarCompraEnlazadaAlCargo, compraEsElMismoGasto, type LectorHolded } from "./gastoYaRegistradoPorCargo";

const cargo = { monto: -21.64, moneda: "EUR", fecha: "2026-10-07", descripcion: "Anthropic" };

test("la compra enlazada es el mismo gasto si coincide proveedor e importe al céntimo", () => {
  assert.equal(compraEsElMismoGasto({ compraId: "c", numero: "VJCCOFZT-0016", contacto: "Anthropic, PBC", total: 21.64, fecha: "2026-10-07" }, cargo, "Anthropic, PBC"), true);
  assert.equal(compraEsElMismoGasto({ compraId: "c", contacto: "Anthropic, PBC", total: 21.58, fecha: "2026-10-05" }, cargo, "Anthropic, PBC"), false);
  assert.equal(compraEsElMismoGasto({ compraId: "c", contacto: "OpenAI", total: 21.64, fecha: "2026-10-07" }, cargo, "Anthropic, PBC"), false);
});

test("sigue el cargo hasta su compra: pago del mismo importe → compra del mismo proveedor (caso Anthropic VJCCOFZT-0016)", async () => {
  const leer: LectorHolded = async (_e, path) => {
    if (path === "/payments") return [
      { id: "p1", amount: "21.58", date: "2026-10-05", type: "purchase", document_id: "c0015" },
      { id: "p2", amount: "21.64", date: "2026-10-07", type: "purchase", document_id: "c0016" },
    ] as never;
    if (path === "/purchases/c0016") return { id: "c0016", contactName: "Anthropic, PBC", total: "21,64", date: "2026-10-07", docNumber: "VJCCOFZT-0016" } as never;
    throw new Error(`no esperado: ${path}`);
  };
  const r = await buscarCompraEnlazadaAlCargo("WOBA" as never, cargo, "Anthropic, PBC", leer);
  assert.equal(r?.numero, "VJCCOFZT-0016"); assert.equal(r?.total, 21.64);
});

test("si el documento enlazado es de otro proveedor, no es este gasto", async () => {
  const leer: LectorHolded = async (_e, path) => {
    if (path === "/payments") return [{ id: "p", amount: "21.64", type: "purchase", document_id: "x" }] as never;
    return { id: "x", contactName: "Google Cloud", total: "21.64", date: "2026-10-07" } as never;
  };
  assert.equal(await buscarCompraEnlazadaAlCargo("WOBA" as never, cargo, "Anthropic, PBC", leer), undefined);
});
