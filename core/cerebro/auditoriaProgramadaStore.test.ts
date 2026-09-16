import assert from "node:assert/strict";
import test from "node:test";
import { normalizarDetallesAuditoria } from "./auditoriaProgramadaStore";

test("normalizarDetallesAuditoria conserva solo resultados conocidos y acotados", () => {
  const detalles = normalizarDetallesAuditoria([
    { nombre: "Typecheck", estado: "ok", detalle: "Sin errores" },
    { nombre: "Pruebas", estado: "atencion", detalle: "Una prueba requiere revisión" },
    { nombre: "", estado: "ok" },
    { nombre: "Inyección", estado: "inventado" },
    null,
  ]);

  assert.deepEqual(detalles, [
    { nombre: "Typecheck", estado: "ok", detalle: "Sin errores" },
    { nombre: "Pruebas", estado: "atencion", detalle: "Una prueba requiere revisión" },
  ]);
});

test("normalizarDetallesAuditoria limita cantidad y longitud", () => {
  const detalles = normalizarDetallesAuditoria(
    Array.from({ length: 35 }, (_, i) => ({ nombre: `Control ${i}`, estado: "ok", detalle: "x".repeat(800) }))
  );

  assert.equal(detalles.length, 30);
  assert.equal(detalles[0].detalle?.length, 600);
});
