import assert from "node:assert/strict";
import test from "node:test";
import { bloqueTieneColumnaEmpresa } from "./cashflowWrite";
import {
  aplicarDestinoRegistroManual, areasDisponiblesRegistroManual, botonesRegistroManualCashflow, esAreaValidaRegistroManual,
} from "./registroManualCashflowDestino";

const base = { empresa: "WOBA", bloque: "pagos_proyectos" as const, clienteOConcepto: "Business Atelier LLC", semana: "S39", valor: 1500,
  resumen: `Business Atelier LLC — semana S39, 1500.00 (bloque "pagos_proyectos")` };

test("la propuesta ofrece todas las áreas y ningún botón supera el límite de Telegram", () => {
  const botones = botonesRegistroManualCashflow("abcdef12", "pagos_proyectos", true).flat();
  assert.equal(botones.length, 7);
  assert.equal(botones[0].callback_data, "regmanualcf_confirmar:abcdef12");
  assert.ok(botones.some((b) => b.callback_data === "regmanualcf_confirmar:abcdef12:pagos_extras"));
  for (const b of botones) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
});

test("sin semana solo se ofrecen las secciones que no la exigen", () => {
  assert.deepEqual(areasDisponiblesRegistroManual(false), ["pagos_pendientes_alberto", "deudas_pendientes"]);
  assert.equal(esAreaValidaRegistroManual("pagos_extras", false), false);
  assert.equal(esAreaValidaRegistroManual("impuestos_por_pagar", true), false);
});

test("cambiar de área ajusta el prefijo de empresa y el resumen", () => {
  const aExtras = aplicarDestinoRegistroManual(base, "pagos_extras");
  assert.equal(aExtras.bloque, "pagos_extras");
  assert.equal(aExtras.clienteOConcepto, bloqueTieneColumnaEmpresa("pagos_extras") ? "Business Atelier LLC" : "WOBA — Business Atelier LLC");
  assert.match(aExtras.resumen, /bloque "pagos_extras"/);
  const deVuelta = aplicarDestinoRegistroManual(aExtras, "pagos_proyectos");
  assert.equal(deVuelta.clienteOConcepto, bloqueTieneColumnaEmpresa("pagos_proyectos") ? "Business Atelier LLC" : "WOBA — Business Atelier LLC");
  assert.equal(aplicarDestinoRegistroManual(base, "pagos_proyectos"), base);
});
