import assert from "node:assert/strict";
import test from "node:test";
import { normalizarCopias } from "./proposeEmail";

test("las copias salen sin repetir, en minúsculas y listas para el encabezado Cc", () => {
  assert.deepEqual(normalizarCopias(["Alberto@Example.com", " simon@example.com ", "alberto@example.com"]), { cc: "alberto@example.com, simon@example.com" });
});

test("sin copias no hay encabezado", () => {
  assert.deepEqual(normalizarCopias(undefined), {});
  assert.deepEqual(normalizarCopias([]), {});
});

test("lo que no es una dirección simple se rechaza: nunca un nombre, una lista pegada ni un salto de línea en el encabezado", () => {
  assert.deepEqual(normalizarCopias(["Alberto"]), { invalida: "Alberto" });
  assert.deepEqual(normalizarCopias(["a@example.com, b@example.com"]), { invalida: "a@example.com, b@example.com" });
  assert.deepEqual(normalizarCopias(["Alberto <a@example.com>"]), { invalida: "Alberto <a@example.com>" });
  assert.equal(normalizarCopias(["a@example.com\r\nBcc: x@example.com"]).invalida !== undefined, true);
});
