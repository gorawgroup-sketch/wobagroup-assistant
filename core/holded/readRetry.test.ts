import assert from "node:assert/strict";
import test from "node:test";
import { conReintentoLecturaHolded, esFalloTransitorioLecturaHolded } from "./readRetry";

function errorHttp(status: number): Error & { status: number } {
  return Object.assign(new Error(`Error de la API de Holded (${status})`), { status });
}

test("una lectura 500 se reintenta con backoff acotado y se recupera", async () => {
  let llamadas = 0;
  const pausas: number[] = [];
  const resultado = await conReintentoLecturaHolded(async () => {
    llamadas++;
    if (llamadas < 3) throw errorHttp(500);
    return "ok";
  }, { esperar: async (ms) => { pausas.push(ms); }, aleatorio: () => 0 });

  assert.equal(resultado, "ok");
  assert.equal(llamadas, 3);
  assert.deepEqual(pausas, [250, 500]);
});

test("un error funcional 4xx no se repite", async () => {
  let llamadas = 0;
  await assert.rejects(() => conReintentoLecturaHolded(async () => {
    llamadas++;
    throw errorHttp(403);
  }, { esperar: async () => {} }), /403/);
  assert.equal(llamadas, 1);
});

test("un fallo de red de lectura es transitorio pero conserva el último error", async () => {
  let llamadas = 0;
  await assert.rejects(() => conReintentoLecturaHolded(async () => {
    llamadas++;
    throw new TypeError("fetch failed");
  }, { intentosMaximos: 2, esperar: async () => {}, aleatorio: () => 0 }), /fetch failed/);
  assert.equal(llamadas, 2);
  assert.equal(esFalloTransitorioLecturaHolded(new TypeError("fetch failed")), true);
});
