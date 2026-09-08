import assert from "node:assert/strict";
import test from "node:test";
import {
  debeEjecutarAutorrevisionApi,
  obtenerProveedorAutorrevision,
  seleccionarRutasAutorrevisionSombra,
} from "./autorrevisionProvider";

test("la autorrevisión conserva API por defecto", () => {
  const proveedor = obtenerProveedorAutorrevision({} as NodeJS.ProcessEnv);
  assert.equal(proveedor, "api");
  assert.equal(debeEjecutarAutorrevisionApi(proveedor), true);
});

test("el modo sombra conserva la comparación con API", () => {
  const proveedor = obtenerProveedorAutorrevision({
    WOBI_AUTOREVISION_PROVIDER: "claude_max_shadow",
  } as NodeJS.ProcessEnv);
  assert.equal(proveedor, "claude_max_shadow");
  assert.equal(debeEjecutarAutorrevisionApi(proveedor), true);
});

test("solo claude_max suspende la llamada API", () => {
  const proveedor = obtenerProveedorAutorrevision({
    WOBI_AUTOREVISION_PROVIDER: "claude_max",
  } as NodeJS.ProcessEnv);
  assert.equal(debeEjecutarAutorrevisionApi(proveedor), false);
});

test("una errata vuelve a API para no perder cobertura", () => {
  const proveedor = obtenerProveedorAutorrevision({
    WOBI_AUTOREVISION_PROVIDER: "claude_mx",
  } as NodeJS.ProcessEnv);
  assert.equal(proveedor, "api");
});

test("la rotación sombra coincide con la selección determinista del workflow", () => {
  assert.deepEqual(
    seleccionarRutasAutorrevisionSombra(
      ["e.ts", "a.ts", "c.ts", "b.ts", "d.ts", "a.ts"],
      new Date("2026-09-08T22:00:00Z")
    ),
    ["c.ts", "d.ts", "e.ts"]
  );
});
