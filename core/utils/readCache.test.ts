import assert from "node:assert/strict";
import test from "node:test";
import {
  CacheLectura,
  limpiarMetricasCachesLecturaParaTests,
  notaFrescura,
  obtenerMetricasCachesLectura,
  resumirMetricasCachesLectura,
} from "./readCache";

function pendiente<T>() {
  let resolve!: (valor: T) => void;
  let reject!: (error: unknown) => void;
  const promesa = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promesa, resolve, reject };
}

test("reutiliza dentro del TTL y expone la antigüedad", async () => {
  limpiarMetricasCachesLecturaParaTests();
  let ahora = 1_000, llamadas = 0;
  const cache = new CacheLectura("prueba_ttl", 500, () => ahora);
  const primera = await cache.obtener(async () => ++llamadas);
  ahora = 1_250;
  const segunda = await cache.obtener(async () => ++llamadas);
  assert.equal(primera.meta.origen, "fresco");
  assert.deepEqual(segunda, { datos: 1, meta: { origen: "cache", obtenidoEn: 1_000, antiguedadMs: 250, ttlMs: 500 } });
  assert.match(notaFrescura(segunda.meta), /caché de hace 1s/);
  assert.equal(llamadas, 1);
  assert.equal(obtenerMetricasCachesLectura().prueba_ttl.llamadasEvitadas, 1);
});

test("deduplica llamadas simultáneas y conserva metadatos distintos", async () => {
  limpiarMetricasCachesLecturaParaTests();
  const carga = pendiente<string>();
  let llamadas = 0;
  const cache = new CacheLectura("prueba_vuelo", 1_000, () => 2_000);
  const a = cache.obtener(async () => { llamadas++; return carga.promesa; });
  const b = cache.obtener(async () => { llamadas++; return "duplicada"; });
  carga.resolve("única");
  const [primera, segunda] = await Promise.all([a, b]);
  assert.equal(llamadas, 1);
  assert.equal(primera.datos, "única");
  assert.equal(primera.meta.origen, "fresco");
  assert.equal(segunda.meta.origen, "compartido");
  assert.equal(obtenerMetricasCachesLectura().prueba_vuelo.llamadasEvitadas, 1);
});

test("invalidar durante una carga descarta la fotografía anterior y relee una sola vez", async () => {
  limpiarMetricasCachesLecturaParaTests();
  const antigua = pendiente<string>();
  let llamadas = 0;
  const cache = new CacheLectura("prueba_invalida", 1_000);
  const cargar = async () => {
    llamadas++;
    return llamadas === 1 ? antigua.promesa : "nueva";
  };
  const a = cache.obtener(cargar);
  const b = cache.obtener(cargar);
  cache.invalidar();
  antigua.resolve("antigua");
  const resultados = await Promise.all([a, b]);
  assert.equal(llamadas, 2);
  assert.deepEqual(resultados.map((r) => r.datos), ["nueva", "nueva"]);
  assert.equal((await cache.obtener(cargar)).datos, "nueva");
});

test("un fallo no se cachea ni sirve un valor vencido", async () => {
  limpiarMetricasCachesLecturaParaTests();
  let ahora = 0, llamadas = 0;
  const cache = new CacheLectura("prueba_error", 10, () => ahora);
  assert.equal((await cache.obtener(async () => { llamadas++; return "inicial"; })).datos, "inicial");
  ahora = 20;
  await assert.rejects(cache.obtener(async () => { llamadas++; throw new Error("fuente caída"); }), /fuente caída/);
  assert.equal((await cache.obtener(async () => { llamadas++; return "recuperada"; })).datos, "recuperada");
  assert.equal(llamadas, 3);
  assert.equal(obtenerMetricasCachesLectura().prueba_error.errores, 1);
});

test("una carga sin uso no mantiene el proceso vivo mediante temporizadores", async () => {
  const cache = new CacheLectura("prueba_sin_timer", 60_000);
  assert.equal((await cache.obtener(async () => 1)).datos, 1);
});

test("TTL cero desactiva reutilización posterior pero conserva single-flight", async () => {
  let llamadas = 0;
  const cache = new CacheLectura("prueba_desactivada", 0, () => 10);
  assert.equal((await cache.obtener(async () => ++llamadas)).datos, 1);
  assert.equal((await cache.obtener(async () => ++llamadas)).datos, 2);
  assert.equal(llamadas, 2);
});

test("una ráfaga de 20 lecturas iguales hace una sola carga y deja métricas agregadas", async () => {
  limpiarMetricasCachesLecturaParaTests();
  let llamadas = 0;
  const cache = new CacheLectura("prueba_rafaga", 10_000);
  const resultados = await Promise.all(
    Array.from({ length: 20 }, () => cache.obtener(async () => {
      llamadas++;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return "resultado";
    }))
  );

  assert.equal(llamadas, 1);
  assert.ok(resultados.every((r) => r.datos === "resultado"));
  assert.deepEqual(resumirMetricasCachesLectura(), {
    cargas: 1,
    cache: 0,
    compartidas: 19,
    llamadasEvitadas: 19,
    invalidaciones: 0,
    errores: 0,
  });
});
