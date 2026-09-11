import assert from "node:assert/strict";
import test from "node:test";
import { CacheMetadataPestanas } from "./sheetsMetadataCache";

const metadata = new Map([
  ["_uno", { gridId: 1, rowCount: 1000 }],
  ["_dos", { gridId: 2, rowCount: 2000 }],
]);

test("comparte una sola carga de metadata entre pestañas y solicitudes concurrentes", async () => {
  let llamadas = 0;
  const cache = new CacheMetadataPestanas(async () => {
    llamadas++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return metadata;
  });

  const resultados = await Promise.all(
    Array.from({ length: 20 }, (_, indice) => cache.obtener(indice % 2 === 0 ? "_uno" : "_dos"))
  );

  assert.equal(llamadas, 1);
  assert.equal(resultados.filter((valor) => valor?.gridId === 1).length, 10);
  assert.equal((await cache.obtener("_dos"))?.rowCount, 2000);
  assert.equal(llamadas, 1);
  assert.deepEqual(cache.diagnostico(), {
    solicitudes: 21,
    cargas: 1,
    reutilizadas: 1,
    compartidas: 19,
    errores: 0,
    pestanasConocidas: 2,
  });
});

test("un fallo no se cachea y la siguiente lectura puede recuperarse", async () => {
  let llamadas = 0;
  const cache = new CacheMetadataPestanas(async () => {
    llamadas++;
    if (llamadas === 1) throw new Error("429 simulado");
    return metadata;
  });

  await assert.rejects(cache.obtener("_uno"), /429 simulado/);
  assert.equal((await cache.obtener("_uno"))?.gridId, 1);
  assert.equal(llamadas, 2);
  assert.equal(cache.diagnostico().errores, 1);
});

test("registra una pestaña creada sin releer todo el spreadsheet", async () => {
  let llamadas = 0;
  const cache = new CacheMetadataPestanas(async () => {
    llamadas++;
    return new Map();
  });

  assert.equal(await cache.obtener("_nueva"), undefined);
  cache.registrar("_nueva", { gridId: 7, rowCount: 1000 });
  assert.deepEqual(await cache.obtener("_nueva"), { gridId: 7, rowCount: 1000 });
  assert.equal(llamadas, 1);
  assert.equal(cache.diagnostico().reutilizadas, 1);
});
