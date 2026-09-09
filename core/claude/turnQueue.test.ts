import assert from "node:assert/strict";
import test from "node:test";
import { ColaTurnos } from "./turnQueue";
import { conTiempoMaximo } from "../utils/asyncTimeout";

test("web y Telegram de la misma identidad conservan orden y liberan tras timeout", async () => {
  const cola = new ColaTurnos();
  const pasos: string[] = [];
  const primero = cola.ejecutar(1, async () => {
    pasos.push("telegram");
    return conTiempoMaximo(() => new Promise(() => {}), 15, "read");
  });
  const rechazo = assert.rejects(primero);
  const segundo = cola.ejecutar(1, async () => { pasos.push("web"); return "ok"; });
  await rechazo;
  assert.equal(await segundo, "ok");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(pasos, ["telegram", "web"]);
  assert.equal(cola.identidadesActivas, 0);
});

test("otra identidad avanza mientras una escritura sigue pendiente", async () => {
  const cola = new ColaTurnos();
  let terminar!: () => void;
  let segundoInicio = false;
  const escritura = cola.ejecutar(1, () => new Promise<void>((resolve) => { terminar = resolve; }));
  const segundo = cola.ejecutar(1, async () => { segundoInicio = true; });
  assert.equal(await cola.ejecutar(2, async () => "independiente"), "independiente");
  assert.equal(segundoInicio, false);
  terminar();
  await Promise.all([escritura, segundo]);
  assert.equal(segundoInicio, true);
});
