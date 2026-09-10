import assert from "node:assert/strict";
import test from "node:test";
import { esperarPrioridadInteractiva } from "./jobPriority";

test("un cron entra inmediatamente si no hay conversación activa", async () => {
  const resultado = await esperarPrioridadInteractiva({
    estado: () => ({ activas: 0, pendientes: 0 }),
    ahora: () => 100,
    graciaMs: 30_000,
  });
  assert.deepEqual(resultado, { esperoMs: 0, agotada: false });
});

test("un cron cede hasta que termina el trabajo interactivo", async () => {
  let instante = 0;
  let consultas = 0;
  const resultado = await esperarPrioridadInteractiva({
    estado: () => ({ activas: consultas++ < 2 ? 1 : 0, pendientes: 0 }),
    esperar: async (ms) => { instante += ms; },
    ahora: () => instante,
    graciaMs: 1_000,
    intervaloMs: 100,
  });
  assert.deepEqual(resultado, { esperoMs: 200, agotada: false });
});

test("la prioridad no puede bloquear un cron indefinidamente", async () => {
  let instante = 0;
  const resultado = await esperarPrioridadInteractiva({
    estado: () => ({ activas: 1, pendientes: 2 }),
    esperar: async (ms) => { instante += ms; },
    ahora: () => instante,
    graciaMs: 250,
    intervaloMs: 100,
  });
  assert.deepEqual(resultado, { esperoMs: 250, agotada: true });
});

test("la prioridad puede desactivarse sin marcar agotamiento", async () => {
  const resultado = await esperarPrioridadInteractiva({
    estado: () => ({ activas: 5, pendientes: 5 }),
    ahora: () => 0,
    graciaMs: 0,
  });
  assert.deepEqual(resultado, { esperoMs: 0, agotada: false });
});
