import assert from "node:assert/strict";
import test from "node:test";
import { alinearDocumentoAlCargoEnOtraMoneda } from "./alinearDocumentoAlCargo";

// Datos reales del caso Gomerco (Footprint, 2026-09-28): ticket 48,65 EUR, cargo −55,32 USD, contable −48,58 EUR.
function escenario() {
  const ediciones: unknown[][] = [];
  const compra: Record<string, unknown> = { total: "48,65", currency: "EUR", currency_change: "1.00", payments_total: "0,00", payments_pending: "48,65", payments_detail: [] };
  const movimiento: Record<string, unknown> = { status: "pending", reconciled_amount: "0.00", currency: "USD", amount: "-55.32", accounting_amount: "-48.58" };
  const elegido = { accountId: "65c4e023574025105f053660", movementId: "6abb83b60c3ddc33020f3b82", fecha: "2026-09-28", monto: -48.58, moneda: "EUR", descripcion: "Gomerco" };
  const deps = {
    leerCompra: async () => compra,
    leerMovimiento: async () => movimiento,
    editar: async (...args: unknown[]) => { ediciones.push(args); return { currency: "USD", total: "55,32", currency_change: "1.14" }; },
  };
  return { ediciones, compra, movimiento, elegido, deps: deps as never };
}

test("caso real: el gasto en EUR pasa a la moneda e importe del cargo, con la tasa implícita del propio cargo", async () => {
  const e = escenario();
  const r = await alinearDocumentoAlCargoEnOtraMoneda("Footprint", "g", e.elegido, e.deps);
  assert.deepEqual(r, { estado: "alineado", moneda: "USD", importe: 55.32, tasa: 1.138740, importeComprobanteEur: 48.65, equivalenteContableEur: 48.58 });
  assert.deepEqual(e.ediciones[0][2], { monedaNueva: "USD", tasaCambioNueva: 1.13874, montoNuevo: 55.32 });
  assert.match(JSON.stringify(e.ediciones[0][3]), /alinear-documento-cargo:g:6abb83b60c3ddc33020f3b82:USD:5532/);
});

test("un reintento con el documento ya alineado no vuelve a editar", async () => {
  const e = escenario();
  Object.assign(e.compra, { currency: "USD", total: "55,32", currency_change: "1.14" });
  assert.deepEqual(await alinearDocumentoAlCargoEnOtraMoneda("Footprint", "g", e.elegido, e.deps), { estado: "ya_alineado", moneda: "USD", importe: 55.32 });
  assert.equal(e.ediciones.length, 0);
});

test("no toca nada cuando gasto y cargo ya están en la misma moneda, ni cuando el gasto no está en EUR", async () => {
  const mismo = escenario(); Object.assign(mismo.movimiento, { currency: "EUR", amount: "-48.65", accounting_amount: null });
  assert.equal((await alinearDocumentoAlCargoEnOtraMoneda("Footprint", "g", mismo.elegido, mismo.deps)).estado, "no_aplica");
  const cop = escenario(); Object.assign(cop.compra, { currency: "COP", total: "16992,00" });
  assert.equal((await alinearDocumentoAlCargoEnOtraMoneda("Footprint", "g", cop.elegido, cop.deps)).estado, "no_aplica");
  assert.equal(mismo.ediciones.length + cop.ediciones.length, 0);
});

test("falla cerrado: pagos previos, cargo ocupado, cargo cambiado, sin equivalente contable o diferencia fuera de margen", async () => {
  const cambios: Array<(e: ReturnType<typeof escenario>) => void> = [
    (e) => { (e.compra.payments_detail as unknown[]).push({ amount: "1" }); },
    (e) => { e.movimiento.status = "reconciled"; },
    (e) => { e.movimiento.accounting_amount = "-47.00"; },
    (e) => { e.movimiento.accounting_amount = null; },
    (e) => { e.compra.total = "90,00"; },
  ];
  for (const cambiar of cambios) {
    const e = escenario(); cambiar(e);
    await assert.rejects(alinearDocumentoAlCargoEnOtraMoneda("Footprint", "g", e.elegido, e.deps));
    assert.equal(e.ediciones.length, 0);
  }
});

test("si Holded no confirma moneda, importe y tasa tras editar, se avisa en vez de conciliar a ciegas", async () => {
  const e = escenario();
  (e.deps as unknown as { editar: unknown }).editar = async () => ({ currency: "EUR", total: "48,65", currency_change: "1.00" });
  await assert.rejects(alinearDocumentoAlCargoEnOtraMoneda("Footprint", "g", e.elegido, e.deps), /relectura no confirma/);
});
