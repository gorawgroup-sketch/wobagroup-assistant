import assert from "node:assert/strict";
import test from "node:test";
import { camposDocumentoParaReparacion, camposEtiquetasParaReparacion, conciliacionMultimonedaDemostrada } from "./flujoExistente";
import { monedaDocumentoAuto, type OperacionAuto, type ReciboAuto } from "./model";

const recibo = (cambios: Partial<ReciboAuto> = {}): ReciboAuto => ({
  fuente: "adjunto-1",
  tipo: "recibo",
  confianza: "alta",
  empresa: "Footprint",
  proveedor: "Kiwi.com s.r.o.",
  fecha: "2026-09-16",
  moneda: "USD",
  monto: 151,
  equivalente: { moneda: "EUR", monto: 130.81 },
  concepto: "Tiquete aéreo",
  evidencia: "Importes visibles en el comprobante",
  evidenciaEmpresa: "Destinatario Footprint",
  ...cambios,
});

test("preserva el importe nativo y obtiene la tasa exacta del equivalente bancario", () => {
  assert.deepEqual(monedaDocumentoAuto(recibo()), {
    moneda: "USD",
    monto: 151,
    tasaCambio: 1.154346,
  });
});

test("un recibo EUR no inventa conversión", () => {
  assert.deepEqual(monedaDocumentoAuto(recibo({
    moneda: "EUR",
    monto: 5.4,
    equivalente: undefined,
  })), { moneda: "EUR", monto: 5.4 });
});

test("una moneda extranjera sin equivalente conserva el monto nativo y deja la tasa para la fuente histórica", () => {
  assert.deepEqual(monedaDocumentoAuto(recibo({ equivalente: undefined })), {
    moneda: "USD",
    monto: 151,
  });
});

test("autoriza cuenta bancaria extranjera cuando Holded demuestra el mismo importe contable", () => {
  const r = recibo({ moneda: "EUR", monto: 20, equivalente: undefined });
  const op = { plan: { recibo: r, totalCentimos: 2000, toleranciaCentimos: 40,
    movimiento: { moneda: "USD", contabilidadCentimos: -2000, monedaContable: "EUR" } } } as OperacionAuto;
  assert.equal(conciliacionMultimonedaDemostrada(op), true);
  op.plan.movimiento.contabilidadCentimos = -2100;
  assert.equal(conciliacionMultimonedaDemostrada(op), false);
});

test("rechaza importe o moneda nativa inválidos antes de escribir", () => {
  assert.throws(() => monedaDocumentoAuto(recibo({ moneda: "US", monto: 151 })),
    /importe_o_moneda_nativa_invalida/);
  assert.throws(() => monedaDocumentoAuto(recibo({ monto: 0 })),
    /importe_o_moneda_nativa_invalida/);
});

test("una reparación conserva el número existente cuando la relectura no lo demuestra", () => {
  assert.deepEqual(camposDocumentoParaReparacion(recibo({ numero: undefined })), {
    fecha: "2026-09-16",
  });
  assert.deepEqual(camposDocumentoParaReparacion(recibo({ numero: " 2026-56028514 " })), {
    fecha: "2026-09-16",
    numeroDocumento: "2026-56028514",
  });
});

test("una reparación conserva categorías verificadas si la nueva lectura solo identifica a la persona", () => {
  assert.deepEqual(camposEtiquetasParaReparacion(["nicolasgomez"]), {});
  assert.deepEqual(camposEtiquetasParaReparacion(["nicolasgomez", "transporte", "avion"]), {
    tagsNuevos: ["nicolasgomez", "transporte", "avion"],
  });
});
