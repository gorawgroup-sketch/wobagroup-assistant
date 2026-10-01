import assert from "node:assert/strict";
import test from "node:test";
import { ConsultaBancariaIncompletaError, paginarMovimientosBancarios } from "./paginarMovimientos";

const paginas = (n: number, porPagina: number) => async (p: Record<string, string>) => {
  const i = p.cursor ? Number(p.cursor) : 0;
  return { items: Array.from({ length: porPagina }, (_, k) => ({ id: `m${i}-${k}` })), has_more: i < n - 1, cursor: i < n - 1 ? String(i + 1) : undefined };
};

test("caso real: un cargo de la cuarta página se lee (antes solo se leía la primera)", async () => {
  const todos = await paginarMovimientosBancarios<{ id: string }>(paginas(4, 200), { start_date: "2026-06-08", end_date: "2026-09-11" });
  assert.equal(todos.length, 800);
  assert.ok(todos.some((m) => m.id === "m3-199"));
});

test("pasa el rango y el cursor a cada página", async () => {
  const vistos: Record<string, string>[] = [];
  await paginarMovimientosBancarios(async (p) => { vistos.push(p); return { items: [], has_more: vistos.length < 2, cursor: "c1" }; }, { start_date: "a", end_date: "b" });
  assert.deepEqual(vistos, [{ limit: "200", start_date: "a", end_date: "b" }, { limit: "200", start_date: "a", end_date: "b", cursor: "c1" }]);
});

test("nunca devuelve una lista parcial como completa", async () => {
  await assert.rejects(paginarMovimientosBancarios(async () => ({ items: [{}], has_more: true }), {}), ConsultaBancariaIncompletaError);
  await assert.rejects(paginarMovimientosBancarios(async () => ({ items: [{}], has_more: true, cursor: "x" }), {}), /repitió el cursor/);
  await assert.rejects(paginarMovimientosBancarios(paginas(10, 1), {}, 3), /más de 3 páginas/);
});

test("acepta la respuesta antigua en forma de lista", async () => {
  assert.deepEqual(await paginarMovimientosBancarios(async () => [{ id: "a" }], {}), [{ id: "a" }]);
});
