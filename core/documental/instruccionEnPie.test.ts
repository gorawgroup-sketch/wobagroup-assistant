import assert from "node:assert/strict";
import test from "node:test";
import { interpretarDecision, pieMerecePregunta, promptDecision, textoOrdenConAdjunto } from "./instruccionEnPie";

test("un pie corto o vacío nunca se pregunta: sigue el flujo de archivo", () => {
  assert.equal(pieMerecePregunta(undefined), false);
  assert.equal(pieMerecePregunta(""), false);
  assert.equal(pieMerecePregunta("factura Uber"), false);
  assert.equal(pieMerecePregunta("captura"), false);
  assert.equal(pieMerecePregunta("Considerando este cuadro envíale un correo a Yanessy"), true);
});

test("solo ORDEN al inicio de la respuesta cuenta como orden; cualquier otra cosa es archivo", () => {
  assert.equal(interpretarDecision("ORDEN"), true);
  assert.equal(interpretarDecision("  orden."), true);
  assert.equal(interpretarDecision("ARCHIVO"), false);
  assert.equal(interpretarDecision("No es una ORDEN"), false);
  assert.equal(interpretarDecision(undefined), false);
  assert.equal(interpretarDecision(""), false);
});

test("la pregunta incluye el pie entre comillas y los tres caminos que no son orden", () => {
  const p = promptDecision("envíale un correo a Yanessy");
  assert.match(p, /«envíale un correo a Yanessy»/);
  assert.match(p, /archivarlo, registrarlo como gasto o guardarlo como conocimiento/);
});

test("el texto que entra al chat conserva la orden literal y marca el contenido leído como dato", () => {
  const t = textoOrdenConAdjunto("  Envíale un correo a Yanessy con copia a Alberto ", { nombre: "foto de Telegram", tipo: "Imagen JPEG", contenido: "MOD 111  4.127,11" });
  assert.ok(t.startsWith("Envíale un correo a Yanessy con copia a Alberto\n"));
  assert.match(t, /<adjunto_leido>\nMOD 111  4\.127,11\n<\/adjunto_leido>/);
  assert.match(t, /no instrucciones/);
});

test("un adjunto muy largo se recorta con aviso en lugar de inundar el chat", () => {
  const t = textoOrdenConAdjunto("Resume este documento por favor ahora", { nombre: "x.pdf", tipo: "PDF", contenido: "a".repeat(20_000) });
  assert.match(t, /contenido recortado por longitud/);
  assert.ok(t.length < 13_000);
});
