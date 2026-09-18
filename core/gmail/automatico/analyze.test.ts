import assert from "node:assert/strict";
import test from "node:test";
import { validarAnalisis } from "./analyze";

test("normaliza fecha española, moneda y equivalente redundante de un recibo pagado", () => {
  const resultado = validarAnalisis({
    completo: true,
    resumen: "Recibo pagado",
    otrasAcciones: false,
    recibos: [{
      fuente: "cuerpo",
      tipo: "recibo",
      confianza: "alta",
      empresa: "Footprint",
      proveedor: "OUIGO ESPAÑA S.A.U.",
      fecha: "09/09/2026",
      moneda: "eur",
      monto: 100,
      equivalente: { moneda: "EUR", monto: 100 },
      concepto: "Billete ya pagado",
      evidencia: "Total pagado 100 EUR",
      evidenciaEmpresa: "Footprint",
    }],
  }, new Set(["cuerpo"]));
  assert.equal(resultado.recibos[0].fecha, "2026-09-09");
  assert.equal(resultado.recibos[0].moneda, "EUR");
  assert.equal(resultado.recibos[0].equivalente, undefined);
});
