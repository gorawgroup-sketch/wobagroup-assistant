import assert from "node:assert/strict";
import test from "node:test";
import { configuracionAuto, evaluarAuto } from "./model";
import { analisisFixture, configFixture, correoFixture, evidenciaFixture, reciboFixture } from "./fixtures";

test("solo un recibo de alta confianza con proveedor exacto y un cargo libre es elegible", () => {
  const d = evaluarAuto(correoFixture(), analisisFixture(), reciboFixture(), evidenciaFixture(), configFixture);
  assert.equal(d.apto, true);
  if (d.apto) assert.equal(d.plan.totalCentimos, 2000);
});
test("un recibo sin cuenta contable verificada queda para revisión manual", () => {
  const r = reciboFixture(); r.tipo = "recibo";
  const e = evidenciaFixture(); e.cuenta = undefined;
  const d = evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture);
  assert.equal(d.apto, false);
  if (!d.apto) assert.ok(d.motivos.includes("cuenta_contable_no_verificada"));
});
test("contacto exacto y cargo único con el proveedor refuerzan una confianza media hasta alta", () => {
  const r = reciboFixture(); r.confianza = "media"; r.proveedor = "Proveedor (Restaurante, Breda)";
  const d = evaluarAuto(correoFixture(), analisisFixture(r), r, evidenciaFixture(), configFixture);
  assert.equal(d.apto, true);
  if (d.apto) {
    assert.equal(d.plan.recibo.confianza, "alta");
    assert.equal(d.plan.evidencia.confianzaReforzada, "contacto_exacto_y_movimiento_unico_con_proveedor");
  }
});
test("una empresa desconocida queda resuelta solo por evidencia determinista de Holded", () => {
  const r = reciboFixture(); r.empresa = "desconocida"; r.confianza = "media";
  const e = evidenciaFixture(); e.empresaDetectada = "WOBA";
  const d = evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture);
  assert.equal(d.apto, true);
  if (d.apto) {
    assert.equal(d.plan.empresa, "WOBA");
    assert.equal(d.plan.recibo.empresa, "WOBA");
  }
});
test("rechaza falta de datos, factura, contacto aproximado no corroborado, empresa ajena y consultas fallidas", () => {
  const casos = [
    () => { const r = reciboFixture(); const e = evidenciaFixture(); r.confianza = "media"; e.movimientos[0].descripcion = "Comercio sin relación"; return { r, e }; },
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
    (e: ReturnType<typeof evidenciaFixture>) => { e.movimientos[0].fecha = "2026-09-24"; },
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
test("usa el equivalente contable real de Holded cuando la cuenta bancaria está en otra moneda", () => {
  const r = reciboFixture(); r.moneda = "USD"; r.monto = 23; r.equivalente = { moneda: "EUR", monto: 20 };
  const e = evidenciaFixture();
  e.movimientos[0] = { ...e.movimientos[0], moneda: "USD", centimos: -2300,
    contabilidadCentimos: -2000, monedaContable: "EUR" };
  const d = evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture);
  assert.equal(d.apto, true);
  if (d.apto) {
    assert.equal(d.plan.totalCentimos, 2000);
    assert.equal(d.plan.regla, "equivalente_contable_holded_2pct_min_005_max_500");
  }
});
test("no infiere una conversión contable si el comprobante no declara un equivalente", () => {
  const r = reciboFixture();
  const e = evidenciaFixture();
  e.movimientos[0] = { ...e.movimientos[0], moneda: "USD", centimos: -2300,
    contabilidadCentimos: -2000, monedaContable: "EUR" };
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture).apto, false);
});
test("una diferencia nativa pequeña usa el cargo bancario real y conserva el importe del recibo", () => {
  const r = reciboFixture(); r.monto = 20.01;
  const d = evaluarAuto(correoFixture(), analisisFixture(r), r, evidenciaFixture(), configFixture);
  assert.equal(d.apto, true);
  if (d.apto) {
    assert.equal(d.plan.totalCentimos, 2000);
    assert.equal(d.plan.diferenciaCentimos, -1);
    assert.equal(d.plan.regla, "moneda_nativa_2pct_min_005_max_500");
  }
  r.monto = 20.5;
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(r), r, evidenciaFixture(), configFixture).apto, false);
});
test("admite hasta noventa días hacia atrás, cinco hacia adelante y rechaza el sexto futuro", () => {
  const e = evidenciaFixture(); e.movimientos[0].fecha = "2026-09-23";
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(), reciboFixture(), e, configFixture).apto, true);
  e.movimientos[0].fecha = "2026-09-24";
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(), reciboFixture(), e, configFixture).apto, false);
});
test("admite un cargo exacto ocurrido noventa días antes de la fecha de servicio", () => {
  const e = evidenciaFixture(); e.movimientos[0].fecha = "2026-06-20";
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(), reciboFixture(), e, configFixture).apto, true);
  e.movimientos[0].fecha = "2026-06-19";
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(), reciboFixture(), e, configFixture).apto, false);
});
test("una coincidencia aproximada exige que el banco confirme el proveedor", () => {
  const r = reciboFixture(); r.monto = 20.01;
  const e = evidenciaFixture(); e.movimientos[0].descripcion = "Comercio distinto";
  const d = evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture);
  assert.equal(d.apto, false);
  if (!d.apto) assert.ok(d.motivos.includes("coincidencia_aproximada_sin_proveedor_bancario"));
});
test("la tolerancia porcentual nunca supera cinco unidades monetarias", () => {
  const r = reciboFixture(); r.monto = 10_000;
  const e = evidenciaFixture(); e.movimientos[0].centimos = -999_400;
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture).apto, false);
  e.movimientos[0].centimos = -999_500;
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture).apto, true);
});
test("un proveedor aproximado único requiere confirmación en el descriptor bancario", () => {
  const r = reciboFixture(); r.proveedor = "DHL";
  const e = evidenciaFixture(); e.contacto = { id: "p1", nombre: "DHL Express Spain SLU", exacto: false, metodo: "aproximado_unico" };
  e.movimientos[0].descripcion = "Compra DHL Express 1234";
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture).apto, true);
  e.movimientos[0].descripcion = "Comercio distinto";
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture).apto, false);
});
test("un nombre aproximado fuerte y único se verifica con importe y fecha bancarios exactos", () => {
  const r = reciboFixture(); r.proveedor = "Delhaize";
  const e = evidenciaFixture();
  e.contacto = { id: "p1", nombre: "Louis Delhaize Brugge", exacto: false, metodo: "aproximado_unico", similitud: 0.52 };
  e.movimientos[0].descripcion = "COMERCIO 38192";
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture).apto, true);
  e.movimientos[0].fecha = "2026-09-17";
  assert.equal(evaluarAuto(correoFixture(), analisisFixture(r), r, e, configFixture).apto, false);
});
test("el descriptor del proveedor desempata dos movimientos cercanos", () => {
  const e = evidenciaFixture();
  e.movimientos.push({ ...e.movimientos[0], id: "otro", descripcion: "Otro comercio", fecha: "2026-09-17" });
  const d = evaluarAuto(correoFixture(), analisisFixture(), reciboFixture(), e, configFixture);
  assert.equal(d.apto, true);
  if (d.apto) assert.equal(d.plan.movimiento.id, "b1");
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
