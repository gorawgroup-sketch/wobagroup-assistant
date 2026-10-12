import assert from "node:assert/strict";
import test from "node:test";
import { textoCorreoReenvioDeclaracion } from "./reenviarDeclaracion";

const cargos = [
  { id: "1", fecha: "2026-09-07", lugar: "Avolta Aams K Comunal 220", valor: 31.25, moneda: "EUR" },
  { id: "2", fecha: "2026-09-13", lugar: "Rist Pizz Tovo", valor: 47.4, moneda: "EUR" },
];

test("el reenvío por adjunto olvidado pide disculpas, lista los cargos y explica paso a paso qué hacer", () => {
  const { asunto, cuerpo } = textoCorreoReenvioDeclaracion({ titular: "German Alejandro Robles", empresa: "EWORKS", cargos, nombreArchivo: "GASTOS SIN SOPORTE GERMAN.docx", motivo: "sin_adjunto" });
  assert.equal(asunto, "EWORKS · Declaración de gastos sin soporte para tu firma");
  assert.match(cuerpo, /^Hola German,/);
  assert.match(cuerpo, /disculpas: en el correo anterior olvidamos adjuntar/);
  assert.match(cuerpo, /«GASTOS SIN SOPORTE GERMAN\.docx»/);
  assert.match(cuerpo, /• 07\/09\/2026 · Avolta Aams K Comunal 220 · 31,25€/);
  assert.match(cuerpo, /Total: 78,65€/);
  assert.match(cuerpo, /1\. Descarga el documento adjunto/);
  assert.match(cuerpo, /2\. Fírmalo/);
  assert.match(cuerpo, /3\. Respóndenos a este mismo correo .* foto .* PDF/);
});

test("el reenvío por no recibido no pide disculpas por un olvido que no hubo", () => {
  const { cuerpo } = textoCorreoReenvioDeclaracion({ titular: "Simon Talloen", empresa: "Footprint", cargos, nombreArchivo: "X.docx", motivo: "no_recibida" });
  assert.match(cuerpo, /por si el correo anterior no te llegó/);
  assert.doesNotMatch(cuerpo, /olvidamos/);
});
