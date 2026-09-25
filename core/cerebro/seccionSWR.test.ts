import { test } from "node:test";
import assert from "node:assert/strict";
import { SeccionSWR } from "./seccionSWR";

const deferred = <T>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { resolve, reject, promise }; };
const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function reloj(inicio = 1_000_000) { let t = inicio; return { ahora: () => t, avanzar: (ms: number) => { t += ms; } }; }

test("la primera lectura espera; las siguientes dentro del TTL son instantáneas y no recargan", async () => {
  let cargas = 0;
  const r = reloj();
  const s = new SeccionSWR({ nombre: "x", ttlMs: 30_000, cargar: async () => ++cargas, ahora: r.ahora });
  assert.equal((await s.leer()).datos, 1);
  r.avanzar(29_000);
  const lectura = await s.leer();
  assert.equal(lectura.datos, 1);
  assert.equal(lectura.vencida, false);
  assert.equal(cargas, 1);
});

test("vencida: devuelve al instante lo último y recalcula detrás, sin bloquear a quien lee", async () => {
  const r = reloj();
  const segunda = deferred<number>();
  let cargas = 0;
  const s = new SeccionSWR({ nombre: "x", ttlMs: 30_000, esperaCoalescerMs: 0, ahora: r.ahora, cargar: () => ++cargas === 1 ? Promise.resolve(1) : segunda.promise });
  await s.leer();
  r.avanzar(31_000);
  const durante = await s.leer(); // NO espera a la segunda carga, que sigue colgada
  assert.equal(durante.datos, 1);
  assert.equal(durante.vencida, true);
  assert.equal(durante.refrescando, true);
  assert.equal(cargas, 2);
  segunda.resolve(2);
  await esperar(5);
  const despues = await s.leer();
  assert.equal(despues.datos, 2);
  assert.equal(despues.refrescando, false);
  assert.equal(despues.vencida, false);
});

test("varias lecturas simultáneas de una sección vencida comparten UN solo recálculo (single-flight)", async () => {
  const r = reloj();
  let cargas = 0;
  const s = new SeccionSWR({ nombre: "x", ttlMs: 10, esperaCoalescerMs: 0, ahora: r.ahora, cargar: async () => { cargas++; await esperar(5); return cargas; } });
  await s.leer();
  r.avanzar(50);
  await Promise.all(Array.from({ length: 20 }, () => s.leer()));
  await esperar(20);
  assert.equal(cargas, 2);
});

test("una ráfaga de invalidaciones se coalesce: no hay una lectura por aviso ni se descarta la lectura en curso", async () => {
  let cargas = 0;
  const primera = deferred<number>();
  const s = new SeccionSWR({ nombre: "x", ttlMs: 60_000, esperaCoalescerMs: 20, cargar: () => ++cargas === 2 ? primera.promise : Promise.resolve(cargas) });
  await s.leer(); // carga 1
  for (let i = 0; i < 50; i++) s.invalidar();
  await esperar(40); // arranca la carga 2 (colgada)
  for (let i = 0; i < 50; i++) s.invalidar(); // llegan más avisos MIENTRAS se lee
  primera.resolve(99);
  await esperar(120);
  // Carga 1 + la colgada + UNA repetición por lo ocurrido durante ella: nunca 100.
  assert.ok(cargas <= 4, `cargas=${cargas}`);
  assert.equal(s.refrescando, false);
  assert.equal((await s.leer()).vencida, false);
});

test("una lectura completada nunca se descarta: se sirve aunque llegue una invalidación durante ella", async () => {
  const lenta = deferred<string>();
  let cargas = 0;
  const s = new SeccionSWR({ nombre: "x", ttlMs: 60_000, esperaCoalescerMs: 0, cargar: () => ++cargas === 1 ? Promise.resolve("a") : cargas === 2 ? lenta.promise : Promise.resolve("c") });
  await s.leer();
  s.invalidar();
  await esperar(5); // la carga 2 está en vuelo
  s.invalidar();
  const mientras = await s.leer(); // el dato viejo, al instante y marcado como refrescando
  assert.equal(mientras.datos, "a");
  assert.equal(mientras.refrescando, true);
  lenta.resolve("b");
  await esperar(20);
  assert.equal((await s.leer()).datos, "c");
});

test("recalcular (botón «actualizar») espera una lectura que EMPIEZA después de la orden y no comparte una anterior en curso", async () => {
  const vieja = deferred<string>();
  let cargas = 0;
  const s = new SeccionSWR({ nombre: "x", ttlMs: 60_000, esperaCoalescerMs: 500, cargar: () => ++cargas === 1 ? Promise.resolve("inicial") : cargas === 2 ? vieja.promise : Promise.resolve("posterior") });
  await s.leer();
  s.invalidar(); // aviso previo: arranca (tras su espera) una carga que terminará DESPUÉS de la orden
  await esperar(600);
  const inicio = Date.now();
  const orden = s.recalcular();
  vieja.resolve("de antes de la orden");
  await orden;
  assert.equal((await s.leer()).datos, "posterior", "la orden no se contesta con una lectura anterior a ella");
  assert.ok(Date.now() - inicio < 400, "sin esperas de coalescencia");
});

test("si la lectura falla se conserva la anterior, sin reintento en bucle, y se recupera después", async () => {
  const r = reloj();
  let fallar = false, cargas = 0;
  const s = new SeccionSWR({ nombre: "x", ttlMs: 10, esperaCoalescerMs: 0, esperaTrasFalloMs: 5_000, ahora: r.ahora, cargar: async () => { cargas++; if (fallar) throw new Error("Holded caído"); return cargas; } });
  assert.equal((await s.leer()).datos, 1);
  fallar = true;
  r.avanzar(100);
  assert.equal((await s.leer()).datos, 1);
  await esperar(10);
  for (let i = 0; i < 30; i++) await s.leer();
  assert.equal(cargas, 2, "un único intento fallido, sin bucle");
  fallar = false;
  r.avanzar(6_000);
  await s.leer(); await esperar(10);
  assert.equal((await s.leer()).datos, 3);
});

test("sin ninguna lectura previa un fallo se propaga (el orquestador usa el valor por defecto)", async () => {
  const s = new SeccionSWR({ nombre: "x", ttlMs: 10, cargar: async () => { throw new Error("nunca cargó"); } });
  await assert.rejects(() => s.leer(), /nunca cargó/);
});

test("demasiado antigua (maxVencidaMs): quien lee espera la lectura nueva en vez de recibir un dato viejo", async () => {
  const r = reloj();
  let cargas = 0;
  const s = new SeccionSWR({ nombre: "x", ttlMs: 10, maxVencidaMs: 1_000, esperaCoalescerMs: 0, ahora: r.ahora, cargar: async () => ++cargas });
  await s.leer();
  r.avanzar(5_000);
  assert.equal((await s.leer()).datos, 2);
});

test("alInvalidar se ejecuta al instante y alCompletarInvalidada solo cuando termina un recálculo provocado por invalidación", async () => {
  const eventos: string[] = [];
  const s = new SeccionSWR({ nombre: "cashflow", ttlMs: 60_000, esperaCoalescerMs: 0, cargar: async () => 1, alInvalidar: () => eventos.push("vaciar-fuente"), alCompletarInvalidada: (n) => eventos.push(`listo:${n}`) });
  await s.leer();
  assert.deepEqual(eventos, [], "la primera lectura no es una invalidación");
  s.invalidar();
  assert.deepEqual(eventos, ["vaciar-fuente"]);
  await esperar(20);
  assert.deepEqual(eventos, ["vaciar-fuente", "listo:cashflow"]);
});

test("invalidar(false) es perezoso: solo marca; la siguiente lectura devuelve lo último como vencido y recalcula una vez", async () => {
  let cargas = 0;
  const s = new SeccionSWR({ nombre: "x", ttlMs: 60_000, esperaCoalescerMs: 0, cargar: async () => ++cargas });
  await s.leer();
  for (let i = 0; i < 30; i++) s.invalidar(false);
  await esperar(20);
  assert.equal(cargas, 1, "ninguna lectura por invalidar perezoso");
  const l = await s.leer();
  assert.equal(l.datos, 1);
  assert.equal(l.vencida, true);
  await esperar(20);
  assert.equal(cargas, 2);
});

test("una lectura colgada termina por timeout propio: no deja el vuelo pegado y se conserva el dato anterior", async () => {
  let cargas = 0;
  const s = new SeccionSWR({ nombre: "x", ttlMs: 5, timeoutCargaMs: 30, esperaCoalescerMs: 0, esperaTrasFalloMs: 0, cargar: () => ++cargas === 1 ? Promise.resolve("ok") : new Promise<string>(() => {}) });
  await s.leer();
  await esperar(10);
  const inicio = Date.now();
  await s.recalcular(); // la lectura nunca termina: debe rendirse por timeout, no colgar
  assert.ok(Date.now() - inicio < 1_000);
  assert.equal((await s.leer()).datos, "ok");
});

test("tras un fallo durante recalcular la bandera urgente no queda pegada (la siguiente ráfaga sigue coalesciendo)", async () => {
  let cargas = 0, fallar = true;
  const s = new SeccionSWR({ nombre: "x", ttlMs: 60_000, esperaCoalescerMs: 40, esperaTrasFalloMs: 0, cargar: async () => { cargas++; if (cargas > 1 && fallar) throw new Error("x"); return cargas; } });
  await s.leer();
  await s.recalcular();
  fallar = false;
  const antes = cargas;
  for (let i = 0; i < 20; i++) s.invalidar();
  await esperar(20);
  assert.equal(cargas, antes, "dentro de la espera de coalescencia aún no se ha leído nada");
  await esperar(120);
  assert.ok(cargas <= antes + 2);
});
