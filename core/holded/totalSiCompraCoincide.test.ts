import test from "node:test";
import assert from "node:assert/strict";
import { totalSiCompraCoincide } from "./write";

const criterios = { proveedor: "Booking.com (Pulse 95 by Wynwood House)", monto: 133.37, moneda: "USD", numeroDocumento: "5580815125" };
const compra = { id: "6ac6", contact_name: "Booking.com (Pulse 95 by Wynwood House)", date: "2026-09-02", total: "133,37", document_number: "5580815125", currency: "usd" };

test("el mismo documento (número + proveedor + importe) coincide", () => {
  assert.equal(totalSiCompraCoincide(criterios, compra), 133.37);
  assert.equal(totalSiCompraCoincide(criterios, compra, true), 133.37);
});

test("el pase ancho exige las tres cosas: sin importe igual o con otro número no coincide", () => {
  assert.equal(totalSiCompraCoincide(criterios, { ...compra, total: "99,00" }, true), undefined);
  assert.equal(totalSiCompraCoincide(criterios, { ...compra, document_number: "5580815126" }, true), undefined);
  assert.equal(totalSiCompraCoincide(criterios, { ...compra, contact_name: "Otro proveedor SL" }, true), undefined);
});

test("el pase ancho no se activa sin número de documento identificable", () => {
  assert.equal(totalSiCompraCoincide({ ...criterios, numeroDocumento: "" }, { ...compra, document_number: "" }, true), undefined);
  assert.equal(totalSiCompraCoincide({ ...criterios, numeroDocumento: "00000" }, { ...compra, document_number: "00000" }, true), undefined);
});

test("las reglas del pase normal siguen igual: proveedor + importe sin número, y la moneda distinta descarta", () => {
  assert.equal(totalSiCompraCoincide({ ...criterios, numeroDocumento: undefined }, { ...compra, document_number: null }), 133.37);
  assert.equal(totalSiCompraCoincide({ ...criterios, numeroDocumento: undefined }, { ...compra, document_number: null, currency: "EUR" }), undefined);
});
