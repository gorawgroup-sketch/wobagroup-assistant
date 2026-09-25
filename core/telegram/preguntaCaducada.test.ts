import assert from "node:assert/strict";
import test from "node:test";
import { registrarPulsacionSobreMensaje, retirarPreguntaCaducada, type DependenciasPreguntaCaducada } from "./preguntaCaducada";
import type { TelegramCallbackQuery } from "./types";
import { mensajeYaNoEsta } from "./client";

function escenario(borrado = true) {
  const eventos: string[] = [];
  const deps: DependenciasPreguntaCaducada = {
    responder: async (id, texto) => { eventos.push(`toast:${id}:${texto ?? ""}`); },
    borrar: async (chat, mensaje) => { eventos.push(`borrar:${chat}:${mensaje}`); return borrado; },
    quitarBotones: async (chat, mensaje) => { eventos.push(`sinBotones:${chat}:${mensaje}`); },
    ahora: () => ahora,
  };
  let ahora = 1_000_000;
  return { eventos, deps, avanzar: (ms: number) => { ahora += ms; } };
}

const cb = (id: string, messageId: number, chatId = 7): TelegramCallbackQuery =>
  ({ id, from: { id: 1 }, data: "x", message: { message_id: messageId, chat: { id: chatId } } } as unknown as TelegramCallbackQuery);

test("una pregunta caducada avisa y desaparece del chat", async () => {
  const e = escenario();
  const callback = cb("a", 501);
  registrarPulsacionSobreMensaje(callback, 1_000_000);
  await retirarPreguntaCaducada(callback, "Ya no está disponible.", e.deps);
  assert.deepEqual(e.eventos, ["toast:a:Ya no está disponible.", "borrar:7:501"]);
});

test("si Telegram no deja borrarla (más de 48 h) al menos se le quitan los botones", async () => {
  const e = escenario(false);
  const callback = cb("b", 502);
  registrarPulsacionSobreMensaje(callback, 1_000_000);
  await retirarPreguntaCaducada(callback, "Ya no está disponible.", e.deps);
  assert.deepEqual(e.eventos, ["toast:b:Ya no está disponible.", "borrar:7:502", "sinBotones:7:502"]);
});

test("otra pulsación reciente sobre el mismo mensaje puede estar procesándolo: no se borra", async () => {
  const e = escenario();
  registrarPulsacionSobreMensaje(cb("c1", 503), 1_000_000);
  const segunda = cb("c2", 503);
  registrarPulsacionSobreMensaje(segunda, 1_000_500);
  await retirarPreguntaCaducada(segunda, "Ya no está disponible.", e.deps);
  assert.deepEqual(e.eventos, ["toast:c2:Ya no está disponible."]);
});

test("una pulsación anterior antigua ya no protege el mensaje", async () => {
  const e = escenario();
  registrarPulsacionSobreMensaje(cb("d1", 504), 1_000_000);
  registrarPulsacionSobreMensaje(cb("d2", 504), 1_000_000 + 6 * 60_000);
  e.avanzar(6 * 60_000);
  await retirarPreguntaCaducada(cb("d2", 504), undefined, e.deps);
  assert.deepEqual(e.eventos, ["toast:d2:", "borrar:7:504"]);
});

test("pulsaciones sobre mensajes o chats distintos no se afectan entre sí", async () => {
  const e = escenario();
  registrarPulsacionSobreMensaje(cb("e1", 505, 7), 1_000_000);
  const otra = cb("e2", 505, 8);
  registrarPulsacionSobreMensaje(otra, 1_000_100);
  await retirarPreguntaCaducada(otra, "x", e.deps);
  assert.ok(e.eventos.includes("borrar:8:505"));
});

test("sin mensaje asociado solo avisa; y un fallo al borrar nunca lanza", async () => {
  const e = escenario();
  await retirarPreguntaCaducada({ id: "f", from: { id: 1 }, data: "x" } as unknown as TelegramCallbackQuery, "x", e.deps);
  assert.deepEqual(e.eventos, ["toast:f:x"]);
  const roto: DependenciasPreguntaCaducada = { ...e.deps, responder: async () => { throw new Error("caducado"); }, borrar: async () => { throw new Error("red"); } };
  const callback = cb("g", 506);
  registrarPulsacionSobreMensaje(callback, 1_000_000);
  await retirarPreguntaCaducada(callback, "x", roto);
});

test("deleteMessage: éxito y «no encontrado» cuentan como desaparecido; otros rechazos no", () => {
  assert.equal(mensajeYaNoEsta(200, ""), true);
  assert.equal(mensajeYaNoEsta(400, '{"ok":false,"description":"Bad Request: message to delete not found"}'), true);
  assert.equal(mensajeYaNoEsta(400, '{"ok":false,"description":"Bad Request: message can\'t be deleted for everyone"}'), false);
  assert.equal(mensajeYaNoEsta(403, '{"ok":false,"description":"Forbidden: bot was blocked by the user"}'), false);
});
