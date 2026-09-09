import assert from "node:assert/strict";
import test from "node:test";
import { conTiempoMaximo, enteroAcotado, TiempoMaximoExcedidoError } from "./asyncTimeout";

test("límites: vacío e inválido usan defecto; números se acotan", () => {
  for (const raw of [undefined, "", "  ", "bad", "Infinity"]) assert.equal(enteroAcotado(raw, 45, 5, 90), 45);
  assert.equal(enteroAcotado("0", 45, 5, 90), 5);
  assert.equal(enteroAcotado("123", 45, 5, 90), 90);
  assert.equal(enteroAcotado("8.9", 45, 5, 90), 8);
});

test("lectura devuelve valor, propaga error y limita una espera bloqueada", async () => {
  assert.equal(await conTiempoMaximo(async () => "ok", 30, "read"), "ok");
  await assert.rejects(conTiempoMaximo(async () => { throw new Error("fallo"); }, 30, "read"), /fallo/);
  await assert.rejects(conTiempoMaximo(() => new Promise(() => {}), 10, "read"), TiempoMaximoExcedidoError);
});

test("un rechazo tardío de la lectura abandonada queda observado", async () => {
  let rechazar!: (error: Error) => void;
  await assert.rejects(conTiempoMaximo(() => new Promise((_, reject) => { rechazar = reject; }), 10, "read"));
  rechazar(new Error("tardío"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});
