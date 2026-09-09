import assert from "node:assert/strict";
import test from "node:test";
import { AcusesCallback } from "./callbackAcknowledgements";

test("acuse temprano libera botón y conserva el rechazo tardío sin duplicarlo", async () => {
  const acuses: (string | undefined)[] = [];
  const avisos: string[] = [];
  const gestor = new AcusesCallback(async (_, texto) => { acuses.push(texto); }, () => assert.fail(), 5);
  try {
    gestor.preparar("a", async (texto) => { avisos.push(texto); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.all([gestor.contestar("a", "No tienes acceso"), gestor.contestar("a", "No tienes acceso")]);
    assert.deepEqual(acuses, [undefined]);
    assert.deepEqual(avisos, ["No tienes acceso"]);
  } finally { gestor.cerrar(); }
});

test("respuesta inmediata cancela acuse genérico y deduplica llamadas concurrentes", async () => {
  const acuses: (string | undefined)[] = [];
  const gestor = new AcusesCallback(async (_, texto) => { acuses.push(texto); }, () => assert.fail(), 5);
  try {
    gestor.preparar("a", async () => assert.fail("toast duplicado"));
    await Promise.all([gestor.contestar("a", "Listo"), gestor.contestar("a", "Listo")]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(acuses, ["Listo"]);
  } finally { gestor.cerrar(); }
});

test("un acuse fallido no envenena respuestas posteriores", async () => {
  let llamadas = 0;
  const gestor = new AcusesCallback(async () => { if (++llamadas === 1) throw new Error("red"); }, () => {}, 5);
  try {
    gestor.preparar("a", async () => {});
    await assert.rejects(gestor.contestar("a"));
    await gestor.contestar("a", "Propuesta caducada");
    assert.equal(llamadas, 2);
  } finally { gestor.cerrar(); }
});
