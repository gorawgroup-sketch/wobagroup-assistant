import assert from "node:assert/strict";
import test from "node:test";
import { extraerRemitenteOriginalDeReenvio } from "./remitenteReenvio";

// Caso real (Carlos, Simon Talloen / Go Rent A Car, 2026-09-30): Carlos reenvía al asistente un
// correo que Simon Talloen le mandó originalmente.
const CORREO_REENVIADO_REAL = `Hola, por favor procesa esto.

---------- Forwarded message ---------
From: Simon Talloen <simon.talloen@gmail.com>
Date: Mon, Sep 28, 2026 at 10:03 AM
Subject: Car rental - 354.62 usd - revolut
To: Carlos <carlos@wobagroup.com>

Hola Carlos, aquí el recibo del alquiler del carro.
`;

test("caso real: extrae nombre y email del remitente original dentro de un reenvío", () => {
  const resultado = extraerRemitenteOriginalDeReenvio(CORREO_REENVIADO_REAL);
  assert.equal(resultado?.email, "simon.talloen@gmail.com");
  assert.equal(resultado?.nombre, "Simon Talloen");
});

test("variante en español del separador ('Mensaje reenviado') y header 'De:'", () => {
  const cuerpo = [
    "---------- Mensaje reenviado ---------",
    "De: Simon Talloen <simon.talloen@gmail.com>",
    "Fecha: lun, 28 sept 2026",
  ].join("\n");
  assert.equal(extraerRemitenteOriginalDeReenvio(cuerpo)?.email, "simon.talloen@gmail.com");
});

test("sin nombre visible, solo el email crudo tras 'From:'", () => {
  const cuerpo = "---------- Forwarded message ---------\nFrom: simon.talloen@gmail.com\n";
  const resultado = extraerRemitenteOriginalDeReenvio(cuerpo);
  assert.equal(resultado?.email, "simon.talloen@gmail.com");
  assert.equal(resultado?.nombre, undefined);
});

test("sin bloque de reenvío, no inventa nada", () => {
  assert.equal(extraerRemitenteOriginalDeReenvio("Hola, aquí va el recibo adjunto."), undefined);
});

test("bloque de reenvío sin una línea From/De reconocible", () => {
  const cuerpo = "---------- Forwarded message ---------\nSubject: algo\nTo: alguien@x.com\n";
  assert.equal(extraerRemitenteOriginalDeReenvio(cuerpo), undefined);
});

// Hallazgo de la misma auditoría que motivó extraerDireccionCorreo (core/gmail/client.ts): nunca
// confiar en una subcadena del header completo — un nombre visible puede contener un email falso.
// Hallazgo real de la revisión adversarial de este mismo fix: el EMAIL quedaba bien protegido, pero
// el "nombre" terminaba siendo esa dirección falsa mostrada como si fuera un nombre humano.
test("nunca se deja engañar por un email falso dentro del nombre visible (ni en el email ni en el nombre)", () => {
  const cuerpo =
    '---------- Forwarded message ---------\nFrom: "no-confiar@falso.com" <real@verdadero.com>\n';
  const resultado = extraerRemitenteOriginalDeReenvio(cuerpo);
  assert.equal(resultado?.email, "real@verdadero.com");
  assert.equal(resultado?.nombre, undefined, "un 'nombre' que es a su vez un email no debe mostrarse como nombre");
});

// Hallazgos reales de la revisión adversarial: un "From:" malformado (ángulo sin cerrar) o un formato
// sin ángulos "Nombre (email)" no deben colar basura como si fuera un email válido.
test("un ángulo sin cerrar en el nombre no produce un email corrupto", () => {
  const cuerpo = "---------- Forwarded message ---------\nFrom: Simon <3 Talloen <simon.talloen@gmail.com>\n";
  assert.equal(extraerRemitenteOriginalDeReenvio(cuerpo), undefined);
});

test("formato 'Nombre (email)' sin ángulos no se confunde con un email válido", () => {
  const cuerpo = "---------- Forwarded message ---------\nFrom: Simon Talloen (simon.talloen@gmail.com)\n";
  assert.equal(extraerRemitenteOriginalDeReenvio(cuerpo), undefined);
});

test("doble reenvío: toma el PRIMER bloque (el reenvío más directo hacia el destinatario final), no uno anidado más adentro", () => {
  const cuerpo = [
    "---------- Forwarded message ---------",
    "From: Simon Talloen <simon.talloen@gmail.com>",
    "",
    "---------- Forwarded message ---------",
    "From: Proveedor Original <proveedor@x.com>",
  ].join("\n");
  assert.equal(extraerRemitenteOriginalDeReenvio(cuerpo)?.email, "simon.talloen@gmail.com");
});
