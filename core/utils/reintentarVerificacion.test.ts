import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reintentarVerificacion } = require("../../scripts/reintentarVerificacion.cjs") as {
  reintentarVerificacion: <T>(f: () => Promise<T>, o?: { intentos?: number; pausaMs?: number; esperar?: (ms: number) => Promise<void>; registrar?: (m: string) => void }) => Promise<T>;
};

const sinEspera = { esperar: async () => undefined };

test("un arranque lento (falla una vez) ya no tumba la verificación", async () => {
  let llamadas = 0;
  const registros: string[] = [];
  const r = await reintentarVerificacion(async () => { if (++llamadas === 1) throw new Error("Timed out after 40000 ms"); return "ok"; }, { ...sinEspera, registrar: (m) => registros.push(m) });
  assert.equal(r, "ok");
  assert.equal(llamadas, 2);
  assert.match(registros[0], /Intento 1\/3 fallido: Timed out/);
});

test("si el motor está de verdad roto fallan todos los intentos y se propaga el último error", async () => {
  let llamadas = 0;
  await assert.rejects(reintentarVerificacion(async () => { llamadas++; throw new Error(`roto ${llamadas}`); }, sinEspera), /roto 3/);
  assert.equal(llamadas, 3);
});

test("no espera tras el último intento y respeta el número de intentos pedido", async () => {
  const pausas: number[] = [];
  let llamadas = 0;
  await assert.rejects(reintentarVerificacion(async () => { llamadas++; throw new Error("x"); }, { intentos: 2, pausaMs: 7, esperar: async (ms) => { pausas.push(ms); } }));
  assert.equal(llamadas, 2);
  assert.deepEqual(pausas, [7]);
});

test("un éxito al primer intento no reintenta ni espera", async () => {
  let llamadas = 0;
  assert.equal(await reintentarVerificacion(async () => { llamadas++; return 1; }, sinEspera), 1);
  assert.equal(llamadas, 1);
});
