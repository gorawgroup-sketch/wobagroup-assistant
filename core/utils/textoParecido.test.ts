import assert from "node:assert/strict";
import test from "node:test";
import { minusculasSinTildes, nombresCoinciden, textosParecidos } from "./textoParecido";

test("nombresCoinciden cubre nombres cortos idénticos que textosParecidos ignora por diseño", () => {
  assert.equal(textosParecidos("Luz", "Luz"), false, "textosParecidos sigue ignorando palabras de menos de 5 letras");
  assert.equal(nombresCoinciden("Luz", "Luz"), true);
  assert.equal(nombresCoinciden("AWS", "aws"), true);
  assert.equal(nombresCoinciden("IVA", "Pago IVA trimestral"), true, "palabra completa dentro del candidato");
  assert.equal(nombresCoinciden("luz", "Soluzione SL"), false, "no por subcadena dentro de otra palabra");
  assert.equal(nombresCoinciden("Sanción", "sancion aeat"), true, "sin distinguir tildes");
  assert.equal(nombresCoinciden("a", "a"), false, "un solo carácter no es un nombre");
  assert.equal(nombresCoinciden("", "algo"), false);
});

test("minusculasSinTildes conserva la puntuación", () => {
  assert.equal(minusculasSinTildes("Bonhomía (pago)"), "bonhomia (pago)");
});
