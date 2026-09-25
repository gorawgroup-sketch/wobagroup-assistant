import { test } from "node:test";
import assert from "node:assert/strict";
import { LecturaFuentes } from "./lecturaFuentes";

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
