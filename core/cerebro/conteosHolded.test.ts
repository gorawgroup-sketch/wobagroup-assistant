import { test } from "node:test";
import assert from "node:assert/strict";
import { ConteosHoldedPesados } from "./conteosHolded";

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function reloj(inicio = 1_000_000) { let t = inicio; return { ahora: () => t, avanzar: (ms: number) => { t += ms; } }; }

test("mientras no hay un primer cálculo completo los conteos son null (nunca un cero inventado)", () => {
  const c = new ConteosHoldedPesados({ gastosSinComprobante: async () => 1, movimientosSinConciliar: async () => 2 });
  const l = c.leer();
  assert.equal(l.gastosSinComprobante, null);
  assert.equal(l.movimientosSinConciliar, null);
  assert.equal(l.actualizadoEn, null);
  assert.equal(l.porEmpresa.WOBA.gastosSinComprobante, null);
});

test("refrescar calcula las 6 métricas en paralelo y suma los totales con su fecha real", async () => {
  const r = reloj();
  let concurrentes = 0, maxConcurrentes = 0;
  const c = new ConteosHoldedPesados({
    gastosSinComprobante: async (e) => { concurrentes++; maxConcurrentes = Math.max(maxConcurrentes, concurrentes); await esperar(10); concurrentes--; return e === "WOBA" ? 5 : e === "EWORKS" ? 0 : 11; },
    movimientosSinConciliar: async (e) => { concurrentes++; maxConcurrentes = Math.max(maxConcurrentes, concurrentes); await esperar(10); concurrentes--; return e === "WOBA" ? 42 : e === "EWORKS" ? 35 : 139; },
  }, { ahora: r.ahora });
  await c.refrescar();
  const l = c.leer();
  assert.equal(l.gastosSinComprobante, 16);
  assert.equal(l.movimientosSinConciliar, 216);
  assert.equal(l.porEmpresa.Footprint.gastosSinComprobante, 11);
  assert.equal(l.actualizadoEn, new Date(r.ahora()).toISOString());
  assert.equal(l.refrescando, false);
  assert.equal(maxConcurrentes, 6, "las 6 lecturas corren a la vez");
});

test("varias órdenes simultáneas comparten un único cálculo; minEdad evita repetir uno reciente", async () => {
  const r = reloj();
  let llamadas = 0;
  const c = new ConteosHoldedPesados({ gastosSinComprobante: async () => { llamadas++; await esperar(5); return 1; }, movimientosSinConciliar: async () => 1 }, { ahora: r.ahora });
  await Promise.all([c.refrescar(), c.refrescar(), c.refrescar()]);
  assert.equal(llamadas, 3, "3 empresas, una vez cada una");
  r.avanzar(60_000);
  await c.refrescar(2 * 60_000);
  assert.equal(llamadas, 3, "el dato de hace 1 min es lo bastante reciente");
  r.avanzar(3 * 60_000);
  await c.refrescar(2 * 60_000);
  assert.equal(llamadas, 6);
});

test("si una lectura falla se conserva el valor anterior y se marca como conservado; si nunca hubo valor, sigue null", async () => {
  const r = reloj();
  let fallar = false;
  const c = new ConteosHoldedPesados({
    gastosSinComprobante: async (e) => { if (fallar && e === "Footprint") throw new Error("Holded 502"); return 3; },
    movimientosSinConciliar: async () => 4,
  }, { ahora: r.ahora });
  await c.refrescar();
  assert.equal(c.leer().conservado, false);
  fallar = true;
  r.avanzar(20 * 60_000);
  await c.refrescar();
  const l = c.leer();
  assert.equal(l.porEmpresa.Footprint.gastosSinComprobante, 3, "se conserva el valor anterior, no un cero");
  assert.equal(l.conservado, true);
  assert.equal(l.gastosSinComprobante, 9);

  const nuevo = new ConteosHoldedPesados({ gastosSinComprobante: async () => { throw new Error("caído"); }, movimientosSinConciliar: async () => 1 });
  await nuevo.refrescar();
  assert.equal(nuevo.leer().gastosSinComprobante, null);
  assert.equal(nuevo.leer().conservado, true);
});

test("un conteo colgado termina por timeout sin bloquear a los demás; valores inválidos se descartan", async () => {
  const c = new ConteosHoldedPesados({
    gastosSinComprobante: (e) => e === "WOBA" ? new Promise<number>(() => {}) : Promise.resolve(Number.NaN),
    movimientosSinConciliar: async () => -1,
  }, { timeoutMs: 20 });
  await c.refrescar();
  const l = c.leer();
  assert.equal(l.gastosSinComprobante, null);
  assert.equal(l.movimientosSinConciliar, null);
  assert.equal(l.conservado, true);
});

test("necesitaRefresco respeta el TTL de 15 min", async () => {
  const r = reloj();
  const c = new ConteosHoldedPesados({ gastosSinComprobante: async () => 1, movimientosSinConciliar: async () => 1 }, { ahora: r.ahora });
  assert.equal(c.necesitaRefresco(), true, "sin primer cálculo");
  await c.refrescar();
  assert.equal(c.necesitaRefresco(), false);
  r.avanzar(14 * 60_000);
  assert.equal(c.necesitaRefresco(), false);
  r.avanzar(2 * 60_000);
  assert.equal(c.necesitaRefresco(), true);
});
