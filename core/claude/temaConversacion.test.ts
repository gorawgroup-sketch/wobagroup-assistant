import assert from "node:assert/strict";
import test from "node:test";
import { notaContinuidadConversacion, textoDeMensajeHistorial, textoMencionaPendiente } from "./temaConversacion";

const anthropic = { proveedor: "Anthropic, PBC", monto: 24.2 };
const telefonica = [
  "el gasto de telefonica ya esta conciliado?",
  "Carlos, revisé de nuevo en Holded: Factura Telefónica (Movistar Empresas) — 208,60 € — WOBA — sigue sin conciliar.",
  "yo ya lo veo conciliado",
  "¿Podrías decirme a cuál factura te refieres? (el Uber de Kelly, el RAPPI, la Telefónica de 32,67 €…)",
];

test("caso real: hablando de Telefónica, «verifica si es un duplicado» no se aplica al pendiente de Anthropic", () => {
  const nota = notaContinuidadConversacion(anthropic, {
    mensajeActual: "verifica si el gasto ya esta creado y conciliado y esto es un duplicado", turnosRecientes: telefonica });
  assert.match(nota, /CONVERSACIÓN EN CURSO/);
  assert.match(nota, /Anthropic, PBC/);
});

test("si el mensaje actual o los últimos turnos nombran el pendiente, el pendiente está en tema", () => {
  assert.equal(notaContinuidadConversacion(anthropic, { mensajeActual: "lo de anthropic descártalo", turnosRecientes: telefonica }), "");
  assert.equal(notaContinuidadConversacion(anthropic, { mensajeActual: "el de 24,20 USD", turnosRecientes: telefonica }), "");
  assert.equal(notaContinuidadConversacion(anthropic, { mensajeActual: "no tengo ese dato",
    turnosRecientes: ["Falta el monto exacto de la factura de Anthropic, PBC (24.2 USD)."] }), "");
});

test("sin conversación previa no se añade nada: la respuesta es al pendiente", () => {
  assert.equal(notaContinuidadConversacion(anthropic, { mensajeActual: "no lo tengo", turnosRecientes: [] }), "");
  assert.equal(notaContinuidadConversacion(anthropic, undefined), "");
});

test("el importe se compara con límites de cifra y el proveedor sin formas societarias", () => {
  assert.equal(textoMencionaPendiente("un cargo de 124,20 €", anthropic), false);
  assert.equal(textoMencionaPendiente("un cargo de 24.20 USD", anthropic), true);
  assert.equal(textoMencionaPendiente("servicios de la empresa", { proveedor: "Servicios Group Limited" }), false);
  assert.equal(textoMencionaPendiente("la de TELEFÓNICA", { proveedor: "Telefónica de España, S.A.U." }), true);
});

test("el texto del historial ignora los bloques de herramienta", () => {
  assert.equal(textoDeMensajeHistorial([{ type: "tool_use", name: "x" }, { type: "text", text: "hola" }]), "hola");
  assert.equal(textoDeMensajeHistorial("directo"), "directo");
});
