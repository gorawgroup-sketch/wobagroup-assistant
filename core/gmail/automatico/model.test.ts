import assert from "node:assert/strict";
import test from "node:test";
import { configuracionAuto, evaluarAuto } from "./model";
import { analisisFixture, configFixture, correoFixture, evidenciaFixture, reciboFixture } from "./fixtures";

test("solo un recibo de alta confianza con proveedor exacto y un cargo libre es elegible", () => {
  const d = evaluarAuto(correoFixture(), analisisFixture(), reciboFixture(), evidenciaFixture(), configFixture);
  assert.equal(d.apto, true);
  if (d.apto) assert.equal(d.plan.totalCentimos, 2000);
});
test("rechaza falta de datos, factura, contacto aproximado, empresa ajena y consultas fallidas", () => {
  const casos = [
    () => { const r = reciboFixture(); r.confianza = "media"; return { r }; },
    () => { const r = reciboFixture(); r.tipo = "factura"; return { r }; },
    () => { const r = reciboFixture(); r.fecha = "2026-02-31"; return { r }; },
    () => { const r = reciboFixture(); r.monto = NaN; return { r }; },
    () => { const r = reciboFixture(); r.empresa = "desconocida"; return { r }; },
    () => { const e = evidenciaFixture(); e.contacto!.exacto = false; return { e }; },
    () => { const e = evidenciaFixture(); e.consultasCompletas = false; return { e }; },
    () => { const e = evidenciaFixture(); e.duplicados = ["documento-ya-registrado"]; return { e }; },
  ];
  for (const caso of casos) {
    const v: { r?: ReturnType<typeof reciboFixture>; e?: ReturnType<typeof evidenciaFixture> } = caso();
    assert.equal(evaluarAuto(correoFixture(), analisisFixture(v.r), v.r ?? reciboFixture(), v.e ?? evidenciaFixture(), configFixture).apto, false);
  }
});
test("ni ingresos, ni conciliaciones parciales, ni estado desconocido, ni varias coincidencias", () => {
  for (const cambiar of [
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos[0].centimos = 2000; },
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos[0].estado = "partial"; },
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos[0].conciliadoCentimos = -1; },
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos[0].estado = ""; },
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos[0].origen = ""; },
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos[0].origen = "manual"; },
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos.push({ ...e.movimientos[0], id: "otro" }); },
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos[0].fecha = "2026-09-17"; },
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos[0].moneda = "USD"; },
  ]) {
    const e = evidenciaFixture(); cambiar(e);
    assert.equal(evaluarAuto(correoFixture(), analisisFixture(), reciboFixture(), e, configFixture).apto, false);
  }
});
test("equivalente explícito permite tolerancia pero conserva el cargo bancario real", () => {
  const r = reciboFixture(); r.moneda = "MXN"; r.monto = 400; r.equivalente = { moneda: "EUR", monto: 20.3 };
  const d = evaluarAuto(correoFixture(), analisisFixture(r), r, evidenciaFixture(), configFixture);
  assert.equal(d.apto, true);
  if (d.apto) { assert.equal(d.plan.totalCentimos, 2000); assert.equal(d.plan.diferenciaCentimos, -30); assert.equal(d.plan.recibo.monto, 400); }
  r.equivalente.monto = 21;
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(r), r, evidenciaFixture(), configFixture).apto, false);
});
test("la tolerancia no cambia el importe de un recibo en moneda nativa", () => {
  const r = reciboFixture(); r.monto = 20.01;
  const d = evaluarAuto(correoFixture(), analisisFixture(r), r, evidenciaFixture(), configFixture);
  assert.equal(d.apto, false);
  if (!d.apto) assert.ok(d.motivos.includes("diferencia_requiere_revision"));
});
test("lectura incompleta y adjunto inventado nunca autorizan", () => {
  const r = reciboFixture(); r.fuente = "adjunto-no-existente";
  const a = analisisFixture(r); a.completo = false;
  assert.equal(evaluarAuto(correoFixture(), a, r, evidenciaFixture(), configFixture).apto, false);
});
test("configuración inválida falla cerrada y el interruptor prevalece", () => {
  assert.throws(() => configuracionAuto({ WOBI_MAIL_AUTO_MODE: "ejecutar" }));
  assert.equal(configuracionAuto({ WOBI_MAIL_AUTO_MODE: "execute", WOBI_MAIL_AUTO_KILL_SWITCH: "true" }).modo, "off");
  assert.equal(configuracionAuto({}).modo, "off");
});
