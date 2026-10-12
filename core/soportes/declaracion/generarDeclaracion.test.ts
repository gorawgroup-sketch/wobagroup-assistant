import assert from "node:assert/strict";
import test from "node:test";
import { textoCorreoDeclaracion } from "./generarDeclaracion";

test("el correo a la persona lista los cargos, el total y pide devolver el documento firmado en el mismo hilo", () => {
  const { asunto, cuerpo } = textoCorreoDeclaracion({ titular: "German Alejandro Robles", empresa: "EWORKS", cargos: [
    { id: "1", fecha: "2026-09-07", lugar: "Avolta Aams K Comunal 220", valor: 31.25, moneda: "EUR" },
    { id: "2", fecha: "2026-09-13", lugar: "Rist Pizz Tovo", valor: 47.4, moneda: "EUR" },
  ] });
  assert.equal(asunto, "EWORKS · Declaración de gastos sin soporte para tu firma");
  assert.match(cuerpo, /^Hola German,/);
  assert.match(cuerpo, /• 07\/09\/2026 · Avolta Aams K Comunal 220 · 31,25€/);
  assert.match(cuerpo, /Total: 78,65€/);
  assert.match(cuerpo, /COMPAÑIA DE PROYECTOS EWORKS, SL/);
  assert.match(cuerpo, /respondiendo a este mismo correo/);
});
