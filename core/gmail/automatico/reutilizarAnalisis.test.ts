import assert from "node:assert/strict";
import test from "node:test";
import { analisisFixture, reciboFixture } from "./fixtures";
import { reutilizarGastoDeAnalisisAutomatico } from "./reutilizarAnalisis";

test("reutiliza un único gasto completo del cuerpo", () => {
  const resultado = reutilizarGastoDeAnalisisAutomatico(analisisFixture());
  assert.equal(resultado.concluyente, true);
  if (resultado.concluyente) {
    assert.equal(resultado.gasto?.proveedor, "Proveedor");
    assert.equal(resultado.gasto?.monto, 20);
    assert.equal(resultado.gasto?.lineas[0].tratamientoFiscal, "inversion_sujeto_pasivo");
  }
});

test("un análisis completo sin gastos evita repetir el extractor", () => {
  const a = analisisFixture(); a.recibos = [];
  assert.deepEqual(reutilizarGastoDeAnalisisAutomatico(a), { concluyente: true });
});

test("lectura incompleta o varios gastos conserva el flujo manual", () => {
  const incompleto = analisisFixture(); incompleto.completo = false;
  assert.deepEqual(reutilizarGastoDeAnalisisAutomatico(incompleto), { concluyente: false });
  const varios = analisisFixture(); varios.recibos.push({ ...reciboFixture(), monto: 30 });
  assert.deepEqual(reutilizarGastoDeAnalisisAutomatico(varios), { concluyente: false });
  const factura = analisisFixture({ ...reciboFixture(), tipo: "factura" });
  assert.deepEqual(reutilizarGastoDeAnalisisAutomatico(factura), { concluyente: false });
});
