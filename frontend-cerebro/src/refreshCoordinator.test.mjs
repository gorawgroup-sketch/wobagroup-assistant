import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshCoordinator, estadoFrescura, fuerzaLecturaNueva, necesitaLecturaNueva } from "./refreshCoordinator.js";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
test("manual y evento durante un sondeo provocan otra lectura, los sondeos no se acumulan", async () => {
  const first = deferred(); const calls = [];
  const c = createRefreshCoordinator(async reason => { calls.push(reason); if (calls.length === 1) await first.promise; return true; });
  const p = c.refresh("intervalo"); await Promise.resolve();
  c.refresh("intervalo"); c.refresh("evento"); const manual = c.refresh("manual");
  first.resolve(); assert.equal(await manual, true); await p;
  assert.deepEqual(calls, ["intervalo", "manual"]);
});
test("cerrar sesión cancela la lectura y descarta las actualizaciones en cola", async () => {
  let aborted = false; let calls = 0;
  const c = createRefreshCoordinator((_r, signal) => new Promise(resolve => { calls++; signal.addEventListener("abort", () => { aborted = true; resolve(false); }); }));
  const p = c.refresh(); await Promise.resolve(); c.refresh("evento"); c.dispose(); await p;
  assert.equal(aborted, true); assert.equal(calls, 1); assert.equal(await c.refresh(), false);
});
test("una consulta colgada termina por timeout y permite reintentar", async () => {
  const c = createRefreshCoordinator((_r, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve(signal.reason.name))), 10);
  assert.equal(await c.refresh(), "TimeoutError"); assert.equal(await c.refresh(), "TimeoutError");
});
test("entrada, regreso, cambios y botón piden otra lectura si algo cambia durante una en curso; la fecha de contacto no oculta antigüedad ni fallos", () => {
  for (const reason of ["entrada", "visibilidad", "online", "reconexion", "manual", "evento"]) assert.equal(necesitaLecturaNueva(reason), true);
  assert.equal(necesitaLecturaNueva("intervalo"), false);
  assert.equal(estadoFrescura({cacheadoEn:new Date(0).toISOString(),generadoEn:new Date(200000).toISOString()},200000),"antiguo");
  assert.equal(estadoFrescura({cacheadoEn:new Date(0).toISOString()},140000),"reciente");
  assert.equal(estadoFrescura({cacheadoEn:new Date().toISOString(),actualizacionParcial:true}),"parcial");
  assert.equal(estadoFrescura({cacheadoEn:new Date().toISOString()}),"reciente");
});

test("solo el botón «actualizar» fuerza al servidor a recalcular: entrar, volver, reconectar y los avisos leen lo último al instante", () => {
  assert.equal(fuerzaLecturaNueva("manual"), true);
  for (const reason of ["entrada", "visibilidad", "online", "reconexion", "evento", "intervalo", "reintento", undefined]) assert.equal(fuerzaLecturaNueva(reason), false, String(reason));
});

test("una orden manual en cola no se degrada por un aviso posterior", async () => {
  const first = deferred(); const calls = [];
  const c = createRefreshCoordinator(async reason => { calls.push(reason); if (calls.length === 1) await first.promise; return true; });
  const p = c.refresh("intervalo"); await Promise.resolve();
  c.refresh("manual"); c.refresh("evento"); c.refresh("visibilidad");
  first.resolve(); await p;
  assert.deepEqual(calls, ["intervalo", "manual"]);
});
