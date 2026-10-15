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

import { destinosReenvio, seleccionarDeclaracionPendiente } from "./reenviarDeclaracion";
import type { Declaracion } from "./declaracionStore";

const base = (x: Partial<Declaracion>): Declaracion => ({ id: "x", empresa: "EWORKS", titular: "German Alejandro Robles", email: "project@wobagroup.com", cargoFirmante: "", chatId: 1,
  cargos, driveFileId: "f", driveUrl: "u", nombreArchivo: "n.docx", estado: "generada", creadoEn: 1, ...x } as Declaracion);

test("la declaración pendiente se localiza sola por nombre parcial, sin correo ni id (caso real: «German»)", () => {
  const pendientes = [base({ id: "german" }), base({ id: "simon", titular: "Simon Talloen", email: "simon@example.com", empresa: "Footprint" }), base({ id: "vieja", estado: "aplicada" })];
  assert.equal(seleccionarDeclaracionPendiente(pendientes, { titular: "German" }).id, "german");
  assert.equal(seleccionarDeclaracionPendiente(pendientes, { titular: "germán robles" }).id, "german");
  assert.equal(seleccionarDeclaracionPendiente(pendientes, { empresa: "Footprint" }).id, "simon");
  assert.equal(seleccionarDeclaracionPendiente(pendientes, { email: "SIMON@example.com" }).id, "simon");
});

test("sin ningún dato, si solo hay una persona pendiente se usa; si hay varias o ninguna, se dice con claridad", () => {
  assert.equal(seleccionarDeclaracionPendiente([base({ id: "unica" })], {}).id, "unica");
  const dos = [base({ id: "a" }), base({ id: "b", titular: "Simon Talloen", email: "simon@example.com" })];
  assert.throws(() => seleccionarDeclaracionPendiente(dos, {}), /varias declaraciones pendientes .*German Alejandro Robles.*Simon Talloen/);
  assert.throws(() => seleccionarDeclaracionPendiente(dos, { titular: "Alberto" }), /No hay ninguna declaración pendiente de firma para Alberto/);
  // Dos declaraciones de la misma persona: se toma la más reciente, no se pregunta.
  assert.equal(seleccionarDeclaracionPendiente([base({ id: "antigua", creadoEn: 1 }), base({ id: "reciente", creadoEn: 2 })], { titular: "German" }).id, "reciente");
});

test("un correo de destino que no coincide con el registrado no bloquea: se localiza por nombre (caso «envíaselo a german@eworkstudio.com»)", () => {
  const pendientes = [base({ id: "german", email: "project@wobagroup.com" }), base({ id: "simon", titular: "Simon Talloen", email: "simon@example.com" })];
  assert.equal(seleccionarDeclaracionPendiente(pendientes, { email: "german@eworkstudio.com", titular: "German" }).id, "german");
  assert.equal(seleccionarDeclaracionPendiente(pendientes, { email: "simon@example.com", titular: "German" }).id, "simon", "si el correo coincide, manda el correo");
  assert.throws(() => seleccionarDeclaracionPendiente(pendientes, { email: "nadie@example.com" }), /varias declaraciones pendientes/);
});

test("el correo registrado siempre va y los indicados por Carlos se añaden sin repetir (caso «deja los 2 mails»)", () => {
  assert.deepEqual(destinosReenvio("project@wobagroup.com", "german@eworkstudio.com"), ["project@wobagroup.com", "german@eworkstudio.com"]);
  assert.deepEqual(destinosReenvio("project@wobagroup.com", "Project@wobagroup.com; otro@x.com"), ["project@wobagroup.com", "otro@x.com"]);
  assert.deepEqual(destinosReenvio("project@wobagroup.com", undefined), ["project@wobagroup.com"]);
});

// Caso real 15-10: «aplica la declaración firmada de German» no encontraba la firmada porque el selector solo miraba generada/enviada.
test("el selector admite buscar las firmadas (aplicar_declaracion_firmada) y lo dice en el error", () => {
  const firmada = { id: "f1", empresa: "EWORKS", titular: "German Alejandro Robles", email: "g@x.com", cargoFirmante: "CEO", chatId: 1, cargos: [], driveFileId: "f", driveUrl: "u", nombreArchivo: "n.docx", estado: "firmada" as const, creadoEn: 1 };
  assert.equal(seleccionarDeclaracionPendiente([firmada as never], { titular: "German" }, ["firmada"]).id, "f1");
  assert.throws(() => seleccionarDeclaracionPendiente([firmada as never], { titular: "German" }), /pendiente de firma/);
  assert.throws(() => seleccionarDeclaracionPendiente([], { titular: "German" }, ["firmada"]), /declaración firmada para German/);
});
