import assert from "node:assert/strict";
import test from "node:test";
import { direccionesDeHeader, extraerDireccionCorreo } from "./client";

test("direccionesDeHeader extrae todas las direcciones de un header con varios destinatarios con nombre", () => {
  const header = '"Sofía Sabjan" <ssabjan@3g-office.com>, "3g office.Recepción" <recepcion.facturas.obras@3g-office.com>, Admin Asistente <asistente@wobagroup.com>';
  assert.deepEqual(direccionesDeHeader(header), [
    "ssabjan@3g-office.com",
    "recepcion.facturas.obras@3g-office.com",
    "asistente@wobagroup.com",
  ]);
});

test("direccionesDeHeader funciona con una lista simple de correos sin nombre para mostrar", () => {
  assert.deepEqual(direccionesDeHeader("uno@x.com, dos@y.com"), ["uno@x.com", "dos@y.com"]);
});

test("direccionesDeHeader devuelve vacío para un header vacío", () => {
  assert.deepEqual(direccionesDeHeader(""), []);
});

test("direccionesDeHeader normaliza mayúsculas y espacios", () => {
  assert.deepEqual(direccionesDeHeader("  Nombre <FOO@Bar.com>  "), ["foo@bar.com"]);
});

test("caso real Alberto Comolli / Sofía Sabjan: el asistente en Cc no cuenta como destinatario en To", () => {
  const to = '"Sofía Sabjan" <ssabjan@3g-office.com>';
  const cc = '"3g office.Recepción" <recepcion.facturas.obras@3g-office.com>, Admin Asistente <asistente@wobagroup.com>';
  const impersonate = extraerDireccionCorreo("Admin Asistente <asistente@wobagroup.com>");

  assert.equal(direccionesDeHeader(to).includes(impersonate), false);
  assert.equal(direccionesDeHeader(cc).includes(impersonate), true);
});
