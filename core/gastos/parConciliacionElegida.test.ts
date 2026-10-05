import assert from "node:assert/strict";
import test from "node:test";

process.env.HOLDED_API_KEY_WRITE_FOOTPRINT = "clave-de-prueba";
process.env.HOLDED_API_KEY_FOOTPRINT = "clave-de-prueba";

import { evaluarParElegido, type MovimientoBancarioLeido } from "./parConciliacionElegida";

// Caso real Nuria/MIMO (Footprint, 2026-10-05): ticket Air France 152,00 EUR frente a Transavia −176,12 USD (−151,95 € contables).
const compraAirFrance = { total: "152,00", currency: "EUR", payments_total: "0,00", payments_detail: [] };
const transavia: MovimientoBancarioLeido = {
  id: "6a96907c6beb2ec14509886c", description: "Transavia", amount: "-176.12", currency: "USD", accounting_amount: "-151.95",
  accounting_currency: "EUR", booking_date: "2026-08-31T00:00:00+00:00", status: "pending", reconciled_amount: "0.00",
};

test("caso Air France ↔ Transavia: gasto EUR contra cargo en cuenta USD → candidato por el equivalente contable, con el importe nativo", () => {
  const r = evaluarParElegido(compraAirFrance, transavia, "cuenta-usd");
  assert.equal(r.estado, "ok");
  if (r.estado !== "ok") return;
  assert.deepEqual(r.candidato, {
    accountId: "cuenta-usd", movementId: "6a96907c6beb2ec14509886c", descripcion: "Transavia", fecha: "2026-08-31",
    origenCoincidencia: "aproximada", monto: -151.95, moneda: "EUR", montoNativo: -176.12, monedaNativa: "USD",
  });
});

test("misma moneda: candidato con el importe nativo", () => {
  const r = evaluarParElegido({ ...compraAirFrance, currency: "USD", total: "176,12" }, transavia, "c");
  assert.equal(r.estado, "ok");
  if (r.estado === "ok") assert.deepEqual([r.candidato.monto, r.candidato.moneda, r.candidato.montoNativo], [-176.12, "USD", undefined]);
});

test("gasto en otra moneda contra cargo en EUR: tipo_cambio (lo resuelve el ajuste de tasa del flujo habitual)", () => {
  const r = evaluarParElegido({ ...compraAirFrance, currency: "COP", total: "446403,00" }, { ...transavia, currency: "EUR", amount: "-120.09", accounting_amount: "-120.09" }, "c");
  assert.equal(r.estado, "ok");
  if (r.estado === "ok") assert.equal(r.candidato.origenCoincidencia, "tipo_cambio");
});

test("se rechaza: gasto con pagos, cargo ocupado o ingreso, diferencia mayor al margen, dos monedas no EUR", () => {
  const motivo = (r: ReturnType<typeof evaluarParElegido>) => (r.estado === "rechazado" ? r.motivo : "OK");
  assert.match(motivo(evaluarParElegido({ ...compraAirFrance, payments_total: "50,00", payments_detail: [{ id: "p", amount: "50,00" }] as never }, transavia, "c")), /ya tiene pagos/);
  assert.match(motivo(evaluarParElegido(compraAirFrance, { ...transavia, status: "reconciled", reconciled_amount: "-176.12" }, "c")), /no está libre/);
  assert.match(motivo(evaluarParElegido(compraAirFrance, { ...transavia, amount: "176.12", accounting_amount: "151.95" }, "c")), /cargo de salida/);
  assert.match(motivo(evaluarParElegido(compraAirFrance, { ...transavia, accounting_amount: "-100.00" }, "c")), /difiere del gasto/);
  assert.match(motivo(evaluarParElegido({ ...compraAirFrance, currency: "COP", total: "446403,00" }, transavia, "c")), /ninguna es EUR/);
  assert.match(motivo(evaluarParElegido(compraAirFrance, { ...transavia, booking_date: undefined }, "c")), /fecha válida/);
});
