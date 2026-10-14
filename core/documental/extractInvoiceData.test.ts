import test from "node:test";
import assert from "node:assert/strict";
import { reporteGastoSinProveedorReal } from "./extractInvoiceData";

test("un reporte de gasto exige un proveedor real", () => {
  assert.equal(reporteGastoSinProveedorReal({ es_factura_o_gasto: true }), true);
  assert.equal(reporteGastoSinProveedorReal({ es_factura_o_gasto: "true", proveedor: "   " }), true);
  assert.equal(reporteGastoSinProveedorReal({ es_factura_o_gasto: true, proveedor: "Aerolínea no identificada en el documento" }), true);
  assert.equal(reporteGastoSinProveedorReal({ es_factura_o_gasto: true, proveedor: "Parking Moraleja" }), false);
  assert.equal(reporteGastoSinProveedorReal({ es_factura_o_gasto: false }), false);
});

import { nombresEnDocumentoDesde } from "./extractInvoiceData";
test("nombres_en_documento: se limpian, no repiten el proveedor y se acotan", () => {
  assert.deepEqual(nombresEnDocumentoDesde(["Queen Home Cinzia", " queen home cinzia ", "Italianway S.p.A.", "ab", 7], "Italianway S.p.A."), ["Queen Home Cinzia"]);
  assert.equal(nombresEnDocumentoDesde(undefined, "X"), undefined);
  assert.equal(nombresEnDocumentoDesde([], "X"), undefined);
});
