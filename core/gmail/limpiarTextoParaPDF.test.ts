import test from "node:test";
import assert from "node:assert/strict";
import { limpiarTextoParaPDF } from "./generarComprobantePDF";

test("los saltos CRLF y CR pasan a LF (sin «Ð» al final de línea)", () => {
  assert.equal(limpiarTextoParaPDF("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("quita caracteres de control y espacios al final de línea, y compacta líneas en blanco", () => {
  assert.equal(limpiarTextoParaPDF("x\u0000y  \n\n\n\n\tz"), "xy\n\n    z");
});

test("acorta los enlaces largos de seguimiento y deja los cortos", () => {
  const largo = "https://www.booking.com/index.es.html?label=gen000nr-10EhJwYXltZW50X3JlY2VpcHRfbWcoggI46AdIClgEaLgCiAEBmAEz";
  const r = limpiarTextoParaPDF(`Ver <${largo}> o https://booking.com/x`);
  assert.ok(r.length < largo.length, r);
  assert.ok(r.includes("…>"));
  assert.ok(r.includes("https://booking.com/x"));
});

test("conserva acentos, ñ y €", () => {
  assert.equal(limpiarTextoParaPDF("Línea ñ € 204,65"), "Línea ñ € 204,65");
});
