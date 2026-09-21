import test from "node:test";
import assert from "node:assert/strict";
import { reporteGastoSinProveedor } from "./extractInvoiceData";

test("un reporte de gasto exige un proveedor real", () => {
  assert.equal(reporteGastoSinProveedor({ es_factura_o_gasto: true }), true);
  assert.equal(reporteGastoSinProveedor({ es_factura_o_gasto: "true", proveedor: "   " }), true);
  assert.equal(reporteGastoSinProveedor({ es_factura_o_gasto: true, proveedor: "Parking Moraleja" }), false);
  assert.equal(reporteGastoSinProveedor({ es_factura_o_gasto: false }), false);
});
