import assert from "node:assert/strict";
import test from "node:test";
import { minusculasSinTildes, nombresCoinciden, nombresIguales, textosParecidos } from "./textoParecido";

test("nombresCoinciden cubre nombres cortos idénticos que textosParecidos ignora por diseño", () => {
  assert.equal(textosParecidos("Luz", "Luz"), false, "textosParecidos sigue ignorando palabras de menos de 5 letras");
  assert.equal(nombresCoinciden("Luz", "Luz"), true);
  assert.equal(nombresCoinciden("AWS", "aws"), true);
  assert.equal(nombresCoinciden("IVA", "Pago IVA trimestral"), true, "palabra completa dentro del candidato");
  assert.equal(nombresCoinciden("luz", "Soluzione SL"), false, "no por subcadena dentro de otra palabra");
  assert.equal(nombresCoinciden("Sanción", "sancion aeat"), true, "sin distinguir tildes");
  assert.equal(nombresCoinciden("a", "a"), false, "un solo carácter no es un nombre");
  // Solo en un sentido: un candidato genérico y corto NO casa con un nombre largo.
  assert.equal(nombresCoinciden("Luz oficina", "Luz"), false);
  assert.equal(nombresCoinciden("Gas Natural", "Gas"), false);
  assert.equal(nombresCoinciden("Pago IT services", "IT"), false);
  assert.equal(nombresCoinciden("", "algo"), false);
});

test("minusculasSinTildes conserva la puntuación", () => {
  assert.equal(minusculasSinTildes("Bonhomía (pago)"), "bonhomia (pago)");
});

test("nombresIguales: el nombre exacto manda sobre los que solo lo contienen", () => {
  assert.equal(nombresIguales("Luz oficina", "luz  OFICINA"), true);
  assert.equal(nombresIguales("Sanción", "sancion"), true);
  assert.equal(nombresIguales("Luz", "Luz oficina"), false);
  assert.equal(nombresIguales("", ""), false);
});
