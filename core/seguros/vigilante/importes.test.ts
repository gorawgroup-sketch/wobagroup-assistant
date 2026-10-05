import assert from "node:assert/strict";
import test from "node:test";
import { formatearEuros, mismoImporte, parsearImporteSimple } from "./importes";

// Textos reales de la columna `prima` del registro de pólizas (2026-10-05).
test("un importe limpio se lee tal cual, con punto o coma decimal", () => {
  assert.equal(parsearImporteSimple("1475.84"), 1475.84);
  assert.equal(parsearImporteSimple("289.14"), 289.14);
  assert.equal(parsearImporteSimple("323,24"), 323.24);
  assert.equal(parsearImporteSimple("1.016,86"), 1016.86);
  assert.equal(parsearImporteSimple("1.306,00 €"), 1306);
  assert.equal(parsearImporteSimple("234"), 234);
});

test("el texto libre de la prima NO se interpreta: ni cuotas, ni «cotizado», ni vacío", () => {
  assert.equal(parsearImporteSimple("1971.86 (2 cuotas semestrales: 1.016,86 + ~955 aprox)"), null);
  assert.equal(parsearImporteSimple("955.73 + 903.11 (2 cuotas semestrales 2025/2026)"), null);
  assert.equal(parsearImporteSimple("529.16 (cotizado, anual)"), null);
  assert.equal(parsearImporteSimple("840.74 + 838.41 (2 cuotas semestrales)"), null);
  assert.equal(parsearImporteSimple(""), null);
  assert.equal(parsearImporteSimple(undefined), null);
});

test("«1.475» es ambiguo (¿1475 o 1,475?) y no se adivina", () => {
  assert.equal(parsearImporteSimple("1.475"), null);
});

test("dos importes son el mismo pago solo si coinciden al céntimo", () => {
  assert.ok(mismoImporte(323.24, 323.24));
  assert.ok(mismoImporte(289.14 + 1016.86, 1306));
  assert.ok(!mismoImporte(323.24, 323.25));
  assert.ok(!mismoImporte(838.41, 840.94));
});

test("los importes se muestran en formato español", () => {
  assert.equal(formatearEuros(1306), "1.306,00");
  assert.equal(formatearEuros(-323.24), "-323,24");
  assert.equal(formatearEuros(2012.65), "2.012,65");
  assert.equal(formatearEuros(5.5), "5,50");
});
