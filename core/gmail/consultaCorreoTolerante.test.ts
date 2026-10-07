import test from "node:test";
import assert from "node:assert/strict";
import { asuntoContieneLasPalabras, consultasDeRespaldo, palabrasDelAsunto } from "./consultaCorreoTolerante";

const ASUNTO = "Fwd: €204.65 - $4,036.92MXN - Hospedaje - Business Trip Guadalajara";

test("quita importes, símbolos y el prefijo de reenvío", () => {
  assert.deepEqual(palabrasDelAsunto(ASUNTO), ["mxn", "hospedaje", "business", "trip", "guadalajara"]);
});

test("genera una consulta de respaldo solo con las palabras", () => {
  assert.deepEqual(consultasDeRespaldo(ASUNTO), ["subject:(mxn hospedaje business trip guadalajara)"]);
});

test("no genera respaldo para consultas de Gmail con operadores ni para búsquedas cortas", () => {
  assert.deepEqual(consultasDeRespaldo("from:alberto@wobagroup.com factura"), []);
  assert.deepEqual(consultasDeRespaldo("Alberto"), []);
  assert.deepEqual(consultasDeRespaldo("la factura de Sinfonía"), []);
});

test("acepta el asunto real que contiene todas las palabras y rechaza uno parecido", () => {
  assert.equal(asuntoContieneLasPalabras(ASUNTO, ASUNTO), true);
  assert.equal(asuntoContieneLasPalabras("Fwd: €204.65 - $4,036.92MXN - Hospedaje - Business Trip Monterrey", ASUNTO), false);
  assert.equal(asuntoContieneLasPalabras("Hospedaje Business Trip Guadalajara", ASUNTO), false);
});
