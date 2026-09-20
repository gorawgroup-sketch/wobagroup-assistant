import assert from "node:assert/strict";
import test from "node:test";
import { mapearConConcurrencia } from "./mapearConConcurrencia";

test("limita lecturas simultáneas y conserva el orden original", async () => {
  let activas = 0, maximas = 0;
  const resultado = await mapearConConcurrencia([3, 1, 2, 0], 2, async (valor) => {
    activas++; maximas = Math.max(maximas, activas);
    await new Promise(resolve => setTimeout(resolve, valor));
    activas--;
    return valor * 2;
  });
  assert.deepEqual(resultado, [6, 2, 4, 0]);
  assert.equal(maximas, 2);
});

test("rechaza límites inválidos", async () => {
  await assert.rejects(mapearConConcurrencia([1], 0, async x => x), /concurrencia inválido/);
});
