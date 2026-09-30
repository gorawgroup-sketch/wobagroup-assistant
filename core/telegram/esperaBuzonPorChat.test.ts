import assert from "node:assert/strict";
import test from "node:test";
import { EsperaBuzonPorChat, textoFinEsperaBuzon } from "./esperaBuzonPorChat";

test("avisa una sola vez al empezar y una sola vez al terminar, con la cuenta real", () => {
  const e = new EsperaBuzonPorChat();
  assert.equal(e.empezar(1), true);
  assert.equal(e.empezar(1), false);
  assert.equal(e.empezar(1), false);
  assert.equal(e.terminar(1, true), undefined);
  assert.equal(e.terminar(1, true), undefined);
  assert.deepEqual(e.terminar(1, true), { aplicadas: 3, fallidas: 0 });
  // Una espera nueva vuelve a avisar.
  assert.equal(e.empezar(1), true);
});

test("cada chat lleva su propia cuenta y las fallidas no se confirman como aplicadas", () => {
  const e = new EsperaBuzonPorChat();
  e.empezar(1); e.empezar(2);
  assert.deepEqual(e.terminar(2, false), { aplicadas: 0, fallidas: 1 });
  assert.equal(textoFinEsperaBuzon({ aplicadas: 0, fallidas: 1 }), undefined);
  assert.deepEqual(e.terminar(1, true), { aplicadas: 1, fallidas: 0 });
  assert.match(textoFinEsperaBuzon({ aplicadas: 1, fallidas: 0 })!, /tu acción en espera ya quedó aplicada/);
  assert.match(textoFinEsperaBuzon({ aplicadas: 2, fallidas: 1 })!, /tus 2 acciones/);
  assert.equal(e.terminar(9, true), undefined);
});
