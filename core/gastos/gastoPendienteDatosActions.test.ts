import assert from "node:assert/strict";
import test from "node:test";
import {
  botonesCargosCandidatos,
  botonesEsperaBancaria,
  botonesFalloTemporalVerificacionPendiente,
  botonesVerificacionDuplicadoPendiente,
  codificarCargoElegido,
  parsearCargoElegido,
} from "./gastoPendienteDatosActions";

test("una verificacion incierta siempre ofrece reprocesar o confirmar y seguir", () => {
  const botones = botonesVerificacionDuplicadoPendiente("abc12345").flat();
  assert.deepEqual(
    botones.map((boton) => boton.callback_data),
    ["gpd_reintentar:abc12345", "gpd_posponer:abc12345", "gpd_confirmar:abc12345"]
  );
  assert.match(botones[0]?.text ?? "", /reprocesar/i);
  assert.match(botones[2]?.text ?? "", /cerrar y seguir/i);
  assert.equal(botones.every((boton) => Buffer.byteLength(boton.callback_data, "utf8") <= 64), true);
});

test("un fallo técnico permite reintentar o seguir, pero nunca confirmar sin evidencia", () => {
  const botones = botonesFalloTemporalVerificacionPendiente("def67890").flat();
  assert.deepEqual(
    botones.map((boton) => boton.callback_data),
    ["gpd_reintentar:def67890", "gpd_posponer:def67890"]
  );
  assert.equal(botones.some((boton) => boton.callback_data.startsWith("gpd_confirmar:")), false);
});

// --- documento que espera al banco / factura en una moneda sin cuenta (caso Anthropic y Uber MXN, 2026-10-06) ---------------

test("un documento que espera al banco ofrece buscar el cargo otra vez y, si viene de la cola, dejarlo pendiente y seguir", () => {
  assert.deepEqual(botonesEsperaBancaria("4854daec", true).flat().map((b) => b.callback_data), ["gpd_reintentar:4854daec", "gpd_posponer:4854daec"]);
  assert.deepEqual(botonesEsperaBancaria("4854daec", false).flat().map((b) => b.callback_data), ["gpd_reintentar:4854daec"]);
  assert.match(botonesEsperaBancaria("x", true)[0][0].text, /Buscar el cargo otra vez/);
});

test("el cargo elegido viaja en el botón con su importe y su moneda, y se lee de vuelta sin pérdida", () => {
  const dato = codificarCargoElegido("18b841ac", { monto: -11.77, moneda: "usd" });
  assert.equal(dato, "gpd_cargo:18b841ac:1177:USD");
  assert.deepEqual(parsearCargoElegido(dato), { id: "18b841ac", monto: 11.77, moneda: "USD" });
  assert.equal(parsearCargoElegido(codificarCargoElegido("a", { monto: 0.07, moneda: "EUR" }))?.monto, 0.07);
  assert.equal(parsearCargoElegido(codificarCargoElegido("a", { monto: 1234567.89, moneda: "COP" }))?.monto, 1234567.89);
});

test("un callback de cargo mal formado, de importe cero o de moneda dudosa se rechaza (nunca se reanuda con un importe dudoso)", () => {
  for (const malo of [
    "gpd_cargo:18b841ac:0:EUR", "gpd_cargo:18b841ac:-5:EUR", "gpd_cargo:18b841ac:abc:EUR", "gpd_cargo:18b841ac:1045:eur",
    "gpd_cargo:18b841ac:1045:EURO", "gpd_cargo::1045:EUR", "gpd_cargo:18b841ac:1045", "gpd_reintentar:18b841ac:1045:EUR", "gpd_cargo:ñ:1045:EUR",
    "gpd_cargo:18b841ac:12345678901:EUR",
  ]) assert.equal(parsearCargoElegido(malo), null, malo);
});

test("un botón por cargo ofrecido (como mucho 5), con el importe REAL del cargo, más buscar otra vez y seguir", () => {
  const cargos = [
    { monto: -11.77, moneda: "USD", fecha: "2026-10-04", descripcion: "Dlo*serv Uber Rides" },
    { monto: -10.55, moneda: "EUR", fecha: "2026-09-30", descripcion: "Dlo*serv Uber Rides Ca" },
    { monto: -9.9, moneda: "EUR", fecha: "2026-09-11", descripcion: "Payu*uber" },
    { monto: -10.61, moneda: "USD", fecha: "2026-09-28", descripcion: "Uber Pending" },
    { monto: -9.38, moneda: "EUR", fecha: "2026-10-05", descripcion: "Dlo*serv Uber Rides Ca" },
    { monto: -1, moneda: "EUR", fecha: "2026-10-05", descripcion: "sexto: no cabe" },
  ];
  const botones = botonesCargosCandidatos("18b841ac", cargos, true).flat();
  assert.equal(botones.length, 5 + 2);
  assert.equal(botones[0].callback_data, "gpd_cargo:18b841ac:1177:USD");
  assert.match(botones[0].text, /^1\) 11\.77 USD · 04\/10 · Dlo\*serv Uber Rides/);
  assert.equal(botones[4].callback_data, "gpd_cargo:18b841ac:938:EUR");
  assert.deepEqual(botones.slice(5).map((b) => b.callback_data), ["gpd_reintentar:18b841ac", "gpd_posponer:18b841ac"]);
  assert.equal(botones.every((b) => Buffer.byteLength(b.callback_data, "utf8") <= 64), true);
  assert.equal(botones.every((b) => b.text.length <= 56), true, "las etiquetas largas se acortan");
  assert.equal(botonesCargosCandidatos("18b841ac", cargos, false).flat().some((b) => b.callback_data.startsWith("gpd_posponer")), false);
});

