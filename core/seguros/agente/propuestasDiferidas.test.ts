import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { diferirPropuesta, enviarPropuestasDiferidas, hayPropuestasDiferidas, ESPERA_MAXIMA_MS } from "./propuestasDiferidas";

const avisos: string[] = [];
const avisar = async (_chatId: number, texto: string) => { avisos.push(texto); };
afterEach(async () => { avisos.length = 0; await enviarPropuestasDiferidas(1, avisar); await enviarPropuestasDiferidas(2, avisar); avisos.length = 0; });

test("no se envía nada al proponer: sale cuando se libera, y en orden", async () => {
  const orden: string[] = [];
  diferirPropuesta(1, async () => { orden.push("a"); }, avisar);
  diferirPropuesta(1, async () => { orden.push("b"); }, avisar);
  assert.deepEqual(orden, []);
  assert.equal(hayPropuestasDiferidas(1), true);
  assert.equal(await enviarPropuestasDiferidas(1, avisar), 2);
  assert.deepEqual(orden, ["a", "b"]);
  assert.equal(hayPropuestasDiferidas(1), false);
});

test("liberar dos veces no repite el envío, y un chat no libera las del otro", async () => {
  let n = 0;
  diferirPropuesta(1, async () => { n++; }, avisar);
  diferirPropuesta(2, async () => { n += 10; }, avisar);
  await enviarPropuestasDiferidas(1, avisar);
  await enviarPropuestasDiferidas(1, avisar);
  assert.equal(n, 1);
  assert.equal(hayPropuestasDiferidas(2), true);
});

test("si un envío falla se avisa en el chat y los siguientes salen igualmente", async () => {
  const salidas: string[] = [];
  diferirPropuesta(1, async () => { throw new Error("telegram caído"); }, avisar);
  diferirPropuesta(1, async () => { salidas.push("segunda"); }, avisar);
  assert.equal(await enviarPropuestasDiferidas(1, avisar), 1);
  assert.deepEqual(salidas, ["segunda"]);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /no pude enviarla con sus botones/);
});

test("red de seguridad: si nadie la libera, sale sola al cabo de la espera máxima", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let enviada = false;
  diferirPropuesta(1, async () => { enviada = true; }, avisar);
  t.mock.timers.tick(ESPERA_MAXIMA_MS + 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(enviada, true);
  assert.equal(hayPropuestasDiferidas(1), false);
});
