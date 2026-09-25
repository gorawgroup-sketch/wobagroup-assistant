import { test } from "node:test";
import assert from "node:assert/strict";
import { mapearConConcurrencia } from "./mapearConConcurrencia";

test("conserva el orden de entrada y respeta el límite de concurrencia", async () => {
  let activos = 0, maximo = 0;
  const r = await mapearConConcurrencia([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { activos++; maximo = Math.max(maximo, activos); await new Promise((x) => setTimeout(x, 5 * (8 - n))); activos--; return n * 10; });
  assert.deepEqual(r, [10, 20, 30, 40, 50, 60, 70]);
  assert.ok(maximo <= 3);
});

test("al primer error rechaza y deja de lanzar tareas nuevas (no gasta cuota pidiendo lo que ya no se usará)", async () => {
  const lanzadas: number[] = [];
  await assert.rejects(() => mapearConConcurrencia(Array.from({ length: 50 }, (_, i) => i), 4, async (n) => {
    lanzadas.push(n);
    await new Promise((x) => setTimeout(x, 2));
    if (n === 3) throw new Error("429");
    return n;
  }), /429/);
  await new Promise((x) => setTimeout(x, 40));
  assert.ok(lanzadas.length <= 12, `lanzadas=${lanzadas.length}`);
});

test("límite inválido y lista vacía", async () => {
  await assert.rejects(() => mapearConConcurrencia([1], 0, async (n) => n), /Límite de concurrencia inválido/);
  assert.deepEqual(await mapearConConcurrencia([], 3, async (n) => n), []);
});
