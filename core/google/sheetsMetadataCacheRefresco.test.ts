import assert from "node:assert/strict";
import test from "node:test";
import { CacheMetadataPestanas } from "./sheetsMetadataCache";

test("una pestaña creada por otro proceso se encuentra al refrescar, sin reinicio", async () => {
  let pestanas = new Map([["_a", { gridId: 1, rowCount: 10 }]]);
  let cargas = 0;
  const cache = new CacheMetadataPestanas(async () => { cargas++; return pestanas; });
  assert.equal(await cache.obtener("_nueva"), undefined);
  pestanas = new Map([...pestanas, ["_nueva", { gridId: 2, rowCount: 10 }]]);
  assert.equal(await cache.obtener("_nueva"), undefined); // la fotografía sigue vieja
  assert.deepEqual(await cache.obtenerRefrescando("_nueva"), { gridId: 2, rowCount: 10 });
  assert.deepEqual(await cache.obtener("_a"), { gridId: 1, rowCount: 10 });
  assert.equal(cargas, 2);
});
