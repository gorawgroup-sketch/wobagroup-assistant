import assert from "node:assert/strict";
import test from "node:test";
import { avisarEsperaInteractiva, conContextoInteractivo, hayContextoInteractivo } from "./contextoInteractivo";

test("fuera de una acción del operador no hay contexto y avisar no hace nada", async () => {
  assert.equal(hayContextoInteractivo(), false);
  await avisarEsperaInteractiva();
});

test("dentro de una acción se avisa una sola vez, aunque varias operaciones esperen, y el contexto cruza awaits", async () => {
  let avisos = 0;
  await conContextoInteractivo(async () => { avisos++; }, async () => {
    await new Promise((r) => setImmediate(r));
    assert.equal(hayContextoInteractivo(), true);
    await Promise.all([avisarEsperaInteractiva(), avisarEsperaInteractiva()]);
    await avisarEsperaInteractiva();
  });
  assert.equal(avisos, 1);
});

test("dos acciones simultáneas avisan cada una por su cuenta y un fallo al avisar no rompe la acción", async () => {
  const avisos: string[] = [];
  await Promise.all([
    conContextoInteractivo(async () => { avisos.push("a"); }, () => avisarEsperaInteractiva()),
    conContextoInteractivo(async () => { throw new Error("Telegram caído"); }, async () => { await avisarEsperaInteractiva(); avisos.push("b sigue"); }),
  ]);
  assert.deepEqual(avisos.sort(), ["a", "b sigue"]);
});
