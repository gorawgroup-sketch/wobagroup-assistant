import assert from "node:assert/strict";
import test from "node:test";
import { completarEquivalenteExplicito } from "./equivalenteExplicito";
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
