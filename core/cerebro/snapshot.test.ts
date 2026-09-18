import { test } from "node:test";
import assert from "node:assert/strict";
import { crearSnapshot } from "./snapshot";
import { LecturaFuentes } from "./lecturaFuentes";

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
test("actualizar ignora el snapshot anterior e invalida las fuentes; varios usuarios comparten la consulta", async () => {
  let loads = 0, invalidations = 0;
  const snapshot = crearSnapshot(async () => ++loads, () => invalidations++);
  assert.equal((await snapshot.obtener()).datos, 1);
  assert.equal((await snapshot.obtener()).datos, 1);
  const values = await Promise.all([snapshot.obtener(true), snapshot.obtener(true), snapshot.obtener()]);
  assert.deepEqual(values.map(v => v.datos), [2, 2, 2]);
  assert.equal(invalidations, 1);
});
test("un cambio durante la lectura nunca repuebla la caché ni responde con el dato anterior", async () => {
  const first = deferred<number>(); let loads = 0;
  const snapshot = crearSnapshot(() => ++loads === 1 ? first.promise : Promise.resolve(2), () => {});
  const before = snapshot.obtener(); await Promise.resolve();
  const manual = snapshot.obtener(true);
  first.resolve(1);
  assert.equal((await before).datos, 2);
  assert.equal((await manual).datos, 2);
  assert.equal((await snapshot.obtener()).datos, 2);
  assert.equal(loads, 2);
});
test("fuente caída conserva su último valor y fecha, sin convertirlo en cero fresco", async () => {
  const reader = new LecturaFuentes();
  const first = await reader.ejecutar(() => reader.leer("correo", async () => 17, 0));
  const failed = await reader.ejecutar(() => reader.leer("correo", async () => { throw Error(); }, 0));
  assert.equal(failed.datos, 17);
  assert.equal(failed.fuentes[0].ok, false);
  assert.equal(failed.fuentes[0].conservado, true);
  assert.equal(failed.fuentes[0].ultimoExitoEn, first.fuentes[0].ultimoExitoEn);
  const recovered = await reader.ejecutar(() => reader.leer("correo", async () => 18, 0));
  assert.equal(recovered.fuentes[0].ok, true);
  assert.equal(recovered.datos, 18);
});
test("una fuente bloqueada queda marcada sin lectura válida y no bloquea todo el panel", async () => {
  const reader = new LecturaFuentes(10);
  const result = await reader.ejecutar(() => reader.leer("drive", () => new Promise(() => {}), []));
  assert.equal(result.fuentes[0].ok, false);
  assert.equal(result.fuentes[0].conservado, false);
  assert.equal(result.fuentes[0].ultimoExitoEn, null);
});
