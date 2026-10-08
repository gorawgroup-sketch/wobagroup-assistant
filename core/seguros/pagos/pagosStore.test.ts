import assert from "node:assert/strict";
import test from "node:test";
import { filaAPago, pagoAFila } from "./pagosStore";
import { pago } from "./pruebas";
import { PAGOS_INICIALES, idPago, pagosSembrados } from "./semilla";

const aFilaCruda = (p: ReturnType<typeof pago>, rowIndex = 5) => ({ rowIndex, valores: pagoAFila(p).map((v) => String(v)) });

test("un pago se escribe y se lee de vuelta sin pérdida (importes con decimales, estimado, avisos, recurrencia)", () => {
  const original = pago({ importe: 2012.65, estimado: true, avisos: "d3,d1", recurrenciaMeses: 12, eventoCalendarId: "evt1", notas: "nota", forma: "transferencia" });
  const leido = filaAPago(aFilaCruda(original, 9));
  assert.deepEqual(leido, { ...original, rowIndex: 9 });
});

test("una fila a medias o editada a mano no rompe la lectura: se ignora", () => {
  const buena = aFilaCruda(pago());
  assert.ok(filaAPago(buena));
  for (const [i, valor] of [[0, ""], [1, ""], [3, "01/03/2027"], [4, "mucho"], [2, "Otra SL"], [10, "pagadísimo"]] as const) {
    const valores = [...buena.valores]; valores[i] = valor;
    assert.equal(filaAPago({ rowIndex: 2, valores }), null, `columna ${i} = «${valor}»`);
  }
  const conComa = [...buena.valores]; conComa[4] = "840,74";
  assert.equal(filaAPago({ rowIndex: 2, valores: conComa })?.importe, 840.74, "una coma decimal escrita a mano se entiende");
  const formaRara = [...buena.valores]; formaRara[9] = "bizum";
  assert.equal(filaAPago({ rowIndex: 2, valores: formaRara })?.forma, "desconocida");
});

test("la siembra: ids únicos y estables, solo pagos futuros previstos, con cuenta de cargo, importe y recurrencia, y sin eventos ni avisos", () => {
  const sembrados = pagosSembrados("2026-10-06T00:00:00.000Z");
  assert.equal(sembrados.length, PAGOS_INICIALES.length);
  assert.equal(new Set(sembrados.map((p) => p.id)).size, sembrados.length);
  for (const p of sembrados) {
    assert.equal(p.id, idPago(p.polizaId, p.fecha));
    assert.equal(p.estado, "previsto");
    assert.ok(p.fecha > "2026-10-06", p.id);
    assert.ok(p.importe > 0 && p.cuentaDeCargo && p.concepto, p.id);
    assert.equal(p.estimado, true, `${p.id}: ningún importe futuro está confirmado todavía`);
    assert.equal(p.eventoCalendarId, "");
    assert.equal(p.avisos, "");
  }
  // Las cuentas de cargo son los nombres exactos de Holded (comprobados en el banco el 06/10/2026).
  assert.deepEqual([...new Set(sembrados.map((p) => `${p.empresa}:${p.cuentaDeCargo}`))].sort(), ["EWORKS:CAIXA BANK EWORKS", "Footprint:Main", "WOBA:BBVA"]);
});
