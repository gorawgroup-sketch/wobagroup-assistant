import test from "node:test";
import assert from "node:assert/strict";
import { empresaNombradaEnTexto } from "./empresaPorComprador";

test("caso real Name.com: el comprador «BUSINESS ATELIER EUROPA SL» es WOBA, no EWORKS", () => {
  assert.equal(empresaNombradaEnTexto("BUSINESS ATELIER EUROPA SL"), "WOBA");
  assert.equal(empresaNombradaEnTexto("Business Atelier Europa, S.L."), "WOBA");
});

test("tolera la errata real «BUSSINES ATELIER EUROPA S.L.» de la factura de Luarca", () => {
  assert.equal(empresaNombradaEnTexto("BUSSINES ATELIER EUROPA S.L."), "WOBA");
});

test("reconoce las tres sociedades con sus variantes", () => {
  assert.equal(empresaNombradaEnTexto("Compañía de Proyectos eWorks SL"), "EWORKS");
  assert.equal(empresaNombradaEnTexto("COMPANIA DE PROYECTOS EWORKS, S.L."), "EWORKS");
  assert.equal(empresaNombradaEnTexto("BUSINESS FOOTPRINT EU SL"), "Footprint");
});

test("«Business Atelier» a secas u otras sociedades no cuentan; tampoco un nombre sin sociedad", () => {
  assert.equal(empresaNombradaEnTexto("Business Atelier Agency"), undefined);
  assert.equal(empresaNombradaEnTexto("Business Atelier LLC (KMINO)"), undefined);
  assert.equal(empresaNombradaEnTexto("eworks.studio"), undefined);
  assert.equal(empresaNombradaEnTexto("Carlos Gonzalez"), undefined);
  assert.equal(empresaNombradaEnTexto(""), undefined);
  assert.equal(empresaNombradaEnTexto(undefined), undefined);
});

test("si el texto nombra a dos sociedades del grupo no se decide", () => {
  assert.equal(empresaNombradaEnTexto("Business Atelier Europa SL / Business Footprint EU SL"), undefined);
});
