import assert from "node:assert/strict";
import test from "node:test";
import { cargoDelAsuntoPolitica, completarEquivalenteExplicito } from "./equivalenteExplicito";
import { analisisFixture, reciboFixture } from "./fixtures";
test("recupera equivalentes omitidos en análisis guardados sin calcular conversiones", () => {
  for (const [monto,eur] of [[194.31,9.89],[589.98,29.99],[4074.95,207.09]]) {
    const a=analisisFixture({...reciboFixture(),moneda:"MXN",monto});
    assert.deepEqual(completarEquivalenteExplicito(a,`Fwd: €${eur} - $${monto}MXN - viaje`).recibos[0].equivalente,{moneda:"EUR",monto:eur});
    assert.equal(a.recibos[0].equivalente,undefined);
  }
});
test("rechaza importes contradictorios, múltiples recibos y montos ambiguos", () => {
  const a=analisisFixture({...reciboFixture(),moneda:"MXN",monto:194.31});
  for(const asunto of ['€9.89 - $200MXN','€9.89 - $194.31MXN - €3.00','€1,234.56 - $194.31MXN']) assert.equal(completarEquivalenteExplicito(a,asunto),a);
  const varios={...a,recibos:[...a.recibos,...a.recibos]};assert.equal(completarEquivalenteExplicito(varios,'€9.89 - $194.31MXN'),varios);
});
test("recupera pesos con separador de miles solo si coinciden con el recibo", () => {
  const a=analisisFixture({...reciboFixture(),moneda:'COP',monto:28471});
  assert.deepEqual(completarEquivalenteExplicito(a,'7.85EUR | 28.471COP - transporte').recibos[0].equivalente,{moneda:'EUR',monto:7.85});
  assert.equal(a.recibos[0].equivalente,undefined);
  for(const subject of ['7.85EUR | 28.472COP','7.85EUR | 28.471,50COP','7.85EUR | 28.471COP | 8.20USD','7.85EUR | 128.471COP']) assert.equal(completarEquivalenteExplicito(a,subject),a);
});

test("política de Footprint: el importe al inicio del asunto es lo cobrado en la tarjeta", () => {
  assert.deepEqual(cargoDelAsuntoPolitica("6,09 euros - Uber Medellin - Visa"), { monto: 6.09, moneda: "EUR" });
  assert.deepEqual(cargoDelAsuntoPolitica("17,96€ - transporte italiano- Mastercard"), { monto: 17.96, moneda: "EUR" });
  assert.deepEqual(cargoDelAsuntoPolitica("Fwd: RV: 12,43 USD - Almuerzo Medellin - Visa"), { monto: 12.43, moneda: "USD" });
  assert.deepEqual(cargoDelAsuntoPolitica("€49 - Taxi - Visa"), { monto: 49, moneda: "EUR" });
  // Un «$» solo es ambiguo (USD, COP, MXN…); un importe que no abre el asunto no es el cargo.
  for (const asunto of ["$12,43 - Almuerzo - Visa", "Factura Citizen M 124,91 EUR", "Uber 6,09 euros - Visa", "6,09 - Uber - Visa",
    "0 euros - prueba - Visa", "6,09 euros", "1234567,00 euros - x - Visa"]) {
    assert.equal(cargoDelAsuntoPolitica(asunto), undefined, asunto);
  }
});

test("caso real Uber Medellín: recibo en COP + asunto «6,09 euros» de alguien del grupo", () => {
  const recibo = { ...reciboFixture(), moneda: "COP", monto: 22943, equivalente: undefined };
  const a = { ...analisisFixture(), recibos: [recibo] };
  const asunto = "6,09 euros - Uber Medellin - Visa";
  assert.deepEqual(completarEquivalenteExplicito(a, asunto, true).recibos[0].equivalente, { monto: 6.09, moneda: "EUR" });
  // Fuera del grupo, con varios recibos o con un equivalente ya leído no se toca nada.
  assert.equal(completarEquivalenteExplicito(a, asunto, false), a);
  assert.equal(completarEquivalenteExplicito(a, asunto), a);
  const varios = { ...a, recibos: [recibo, recibo] };
  assert.equal(completarEquivalenteExplicito(varios, asunto, true), varios);
  const yaTiene = { ...a, recibos: [{ ...recibo, equivalente: { monto: 6.5, moneda: "EUR" } }] };
  assert.equal(completarEquivalenteExplicito(yaTiene, asunto, true), yaTiene);
});

test("mismo importe y moneda que el comprobante no añade nada; un cargo distinto en la misma moneda sí", () => {
  const eur = { ...analisisFixture(), recibos: [{ ...reciboFixture(), moneda: "EUR", monto: 17.96, equivalente: undefined }] };
  assert.equal(completarEquivalenteExplicito(eur, "17,96€ - transporte italiano - Mastercard", true), eur);
  const neto = { ...analisisFixture(), recibos: [{ ...reciboFixture(), moneda: "EUR", monto: 16.33, equivalente: undefined }] };
  assert.deepEqual(completarEquivalenteExplicito(neto, "17,96€ - transporte italiano - Mastercard", true).recibos[0].equivalente,
    { monto: 17.96, moneda: "EUR" });
});
