import assert from "node:assert/strict";
import test from "node:test";
import { residuoCambioToleradoEntreMonedas } from "./write";

/**
 * Caso real 2026-10-14: Uber 23.956 COP pagado con un cargo de 7,39 USD (6,59 € contables). Tasa del documento 3623,19: quedan 72,46 COP (≈ 0,02 €)
 * sin cubrir. El cargo está conciliado al 100 % y la compra pagada por el importe contable; antes la conciliación quedaba «incierta» para siempre.
 */
const uber = { currency: "COP", currency_change: "3623.19", total: "23956,00", payments_total: "23876,82", payments_pending: "72,46" };

test("el resto de cambio del Uber real (0,3 % y 0,02 €) entre COP y USD se tolera", () => {
  assert.equal(residuoCambioToleradoEntreMonedas(uber, "USD"), true);
});

test("no se tolera si gasto y cargo comparten moneda (ahí rige el ajuste automático), ni sin moneda de movimiento", () => {
  assert.equal(residuoCambioToleradoEntreMonedas(uber, "COP"), false);
  assert.equal(residuoCambioToleradoEntreMonedas(uber, undefined), false);
});

test("no se tolera una deuda real: más del 2 % del total, más de 1 €, o pagado + pendiente que no recompone el total", () => {
  assert.equal(residuoCambioToleradoEntreMonedas({ ...uber, payments_total: "22758,20", payments_pending: "1197,80" }, "USD"), false, "5 % del total");
  assert.equal(residuoCambioToleradoEntreMonedas({ currency: "USD", currency_change: "1.16", total: "1000,00", payments_total: "970,00", payments_pending: "20,00" }, "EUR"), false, "pagado + pendiente = 990 ≠ 1000");
  assert.equal(residuoCambioToleradoEntreMonedas({ currency: "COP", currency_change: "3623.19", total: "900000,00", payments_total: "890000,00", payments_pending: "10000,00" }, "USD"), false, "1,1 % pero ≈ 2,76 €");
  assert.equal(residuoCambioToleradoEntreMonedas({ ...uber, payments_pending: "0,00" }, "USD"), false, "sin resto no hay nada que tolerar");
});

test("sin tasa legible en un documento no EUR no se tolera nada; un documento en EUR usa tasa 1", () => {
  assert.equal(residuoCambioToleradoEntreMonedas({ ...uber, currency_change: undefined }, "USD"), false);
  assert.equal(residuoCambioToleradoEntreMonedas({ currency: "EUR", total: "6,61", payments_total: "6,59", payments_pending: "0,02" }, "USD"), true);
});
