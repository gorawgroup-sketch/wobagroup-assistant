import test from "node:test";
import assert from "node:assert/strict";
import { borrarSnapshotLocal, CLAVE_SNAPSHOT_LOCAL, EDAD_MAXIMA_SNAPSHOT_MS, guardarSnapshotLocal, huellaToken, leerSnapshotLocal } from "./snapshotLocal.js";

const almacen = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k), m }; };
const datos = (cacheadoEn = new Date().toISOString()) => ({ cacheadoEn, holded: { gastosSinComprobante: 5 } });

test("guarda y recupera la última lectura de la misma sesión", () => {
  const a = almacen();
  assert.equal(guardarSnapshotLocal(a, "tok", datos(), 1_000), true);
  assert.deepEqual(leerSnapshotLocal(a, "tok", 2_000).holded, { gastosSinComprobante: 5 });
});

test("nunca muestra la lectura de otra sesión (otro token) ni la que tiene forma inválida", () => {
  const a = almacen();
  guardarSnapshotLocal(a, "tok", datos(), 1_000);
  assert.equal(leerSnapshotLocal(a, "otro", 2_000), null);
  assert.notEqual(huellaToken("tok"), huellaToken("otro"));
  a.setItem(CLAVE_SNAPSHOT_LOCAL, JSON.stringify({ huella: huellaToken("tok"), guardadoEn: 1_000, datos: { sinFecha: true } }));
  assert.equal(leerSnapshotLocal(a, "tok", 2_000), null, "sin cacheadoEn válido");
  a.setItem(CLAVE_SNAPSHOT_LOCAL, "{no es json");
  assert.equal(leerSnapshotLocal(a, "tok", 2_000), null, "JSON corrupto");
});

test("caduca a las 12 h y rechaza fechas futuras", () => {
  const a = almacen();
  guardarSnapshotLocal(a, "tok", datos(), 1_000);
  assert.notEqual(leerSnapshotLocal(a, "tok", 1_000 + EDAD_MAXIMA_SNAPSHOT_MS), null);
  assert.equal(leerSnapshotLocal(a, "tok", 1_001 + EDAD_MAXIMA_SNAPSHOT_MS), null);
  assert.equal(leerSnapshotLocal(a, "tok", 1_000 - 120_000), null, "guardado en el futuro respecto al reloj actual");
});

test("un almacén que falla o está bloqueado nunca lanza; sin token o sin datos no guarda", () => {
  const roto = { getItem() { throw new Error("bloqueado"); }, setItem() { throw new Error("cuota"); }, removeItem() { throw new Error("x"); } };
  assert.equal(guardarSnapshotLocal(roto, "tok", datos()), false);
  assert.equal(leerSnapshotLocal(roto, "tok"), null);
  assert.doesNotThrow(() => borrarSnapshotLocal(roto));
  assert.equal(leerSnapshotLocal(null, "tok"), null);
  assert.equal(guardarSnapshotLocal(almacen(), "", datos()), false);
  assert.equal(guardarSnapshotLocal(almacen(), "tok", null), false);
});

test("una lectura enorme no se guarda y borrar la elimina", () => {
  const a = almacen();
  assert.equal(guardarSnapshotLocal(a, "tok", { ...datos(), relleno: "x".repeat(700_000) }), false);
  guardarSnapshotLocal(a, "tok", datos(), 1_000);
  borrarSnapshotLocal(a);
  assert.equal(leerSnapshotLocal(a, "tok", 2_000), null);
});
