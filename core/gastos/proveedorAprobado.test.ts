import assert from "node:assert/strict";
import test from "node:test";
import { debeRecordarProveedorAprobado } from "./proveedorAliasSheet";

test("recuerda el proveedor cuando el contacto aprobado no se llama igual que el nombre leído", () => {
  assert.equal(debeRecordarProveedorAprobado("McDonald's Breda Centrum", "MCDONALD'S RESTAURANT"), true);
  assert.equal(debeRecordarProveedorAprobado("Antaris Suite", "ANTARISUITE GALERIAS R"), true);
});

test("no recuerda nada si ya coinciden, si falta un nombre o si es el contacto genérico", () => {
  assert.equal(debeRecordarProveedorAprobado("Uber", "UBER"), false);
  assert.equal(debeRecordarProveedorAprobado("Telefónica, S.A.", "telefonica sa"), false);
  assert.equal(debeRecordarProveedorAprobado("Kiosko", undefined), false);
  assert.equal(debeRecordarProveedorAprobado("", "X"), false);
  assert.equal(debeRecordarProveedorAprobado("Aeropuerto de Panamá", "PROVEEDOR SIN IDENTIFICAR"), false);
});
