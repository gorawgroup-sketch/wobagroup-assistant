import assert from "node:assert/strict";
import test from "node:test";
import { PREFIJO_RESPUESTA_CARPETA, resolverRespuestaCarpeta, solicitarRespuestaCarpeta } from "./respuestaCarpeta";
import { parseIncomingUpdate } from "../telegram/client";
import type { PendienteDesambiguacion } from "./disambiguationStore";

function escenario() {
  const pendientes: PendienteDesambiguacion[] = [1, 2].map((n) => ({
    id: `adjunto-${n}`, chatId: 77, messageId: n * 100,
    rutaLocal: `/tmp/${n}.pdf`, nombreArchivoOriginal: `proforma-${n}.pdf`,
    nombreParaClasificar: `proforma-${n}.pdf`, preguntaFormulada: "¿En qué carpeta va?", creadoEn: n,
  }));
  const enviados: string[] = [];
  const avisos: string[] = [];
  const consumidos: string[] = [];
  const deps = {
    listar: async (chatId: number) => pendientes.filter((p) => p.chatId === chatId),
    enviar: async (_chatId: number, texto: string) => { enviados.push(texto); return 900 + enviados.length; },
    registrar: async (id: string, chatId: number, messageId: number) => {
      const p = pendientes.find((p) => p.id === id && p.chatId === chatId);
      if (!p) return false;
      p.respuestaMessageIds = [...(p.respuestaMessageIds ?? []), messageId];
      return true;
    },
    consumir: async (id: string, chatId: number) => {
      const i = pendientes.findIndex((p) => p.id === id && p.chatId === chatId);
      if (i < 0) return undefined;
      consumidos.push(id);
      return pendientes.splice(i, 1)[0];
    },
    avisar: async (_chatId: number, texto: string) => { avisos.push(texto); },
  };
  return { pendientes, enviados, avisos, consumidos, deps };
}

test("pulsar indicar carpeta abre la respuesta sin consumir el adjunto", async () => {
  const e = escenario();
  await solicitarRespuestaCarpeta(77, "adjunto-2", e.deps);
  assert.match(e.enviados[0], /proforma-2.pdf/);
  assert.match(e.enviados[0], /¿En qué carpeta va\?/);
  assert.deepEqual(e.pendientes[1].respuestaMessageIds, [901]);
  assert.deepEqual(e.consumidos, []);
  assert.equal(e.pendientes.length, 2);
});

test("contestar al segundo adjunto no aplica la carpeta al primero", async () => {
  const e = escenario();
  await solicitarRespuestaCarpeta(77, "adjunto-2", e.deps);
  let resuelto: string | undefined;
  assert.equal(await resolverRespuestaCarpeta(77, 901, e.enviados[0], async (p) => { resuelto = p.id; }, e.deps), true);
  assert.equal(resuelto, "adjunto-2");
  assert.deepEqual(e.pendientes.map((p) => p.id), ["adjunto-1"]);
});

test("responder directamente al mensaje original también selecciona su adjunto", async () => {
  const e = escenario();
  await resolverRespuestaCarpeta(77, 200, "¿Dónde va?", async (p) => { assert.equal(p.id, "adjunto-2"); }, e.deps);
  assert.deepEqual(e.consumidos, ["adjunto-2"]);
});

test("un prompt ya resuelto no consume el otro adjunto", async () => {
  const e = escenario();
  await solicitarRespuestaCarpeta(77, "adjunto-2", e.deps);
  await e.deps.consumir("adjunto-2", 77);
  assert.equal(await resolverRespuestaCarpeta(77, 901, e.enviados[0], async () => assert.fail(), e.deps), true);
  assert.equal(e.avisos.length, 1);
  assert.deepEqual(e.pendientes.map((p) => p.id), ["adjunto-1"]);
});

test("un chat distinto no puede seleccionar ni consumir el documento", async () => {
  const e = escenario();
  await solicitarRespuestaCarpeta(88, "adjunto-2", e.deps);
  await resolverRespuestaCarpeta(88, 200, PREFIJO_RESPUESTA_CARPETA, async () => assert.fail(), e.deps);
  assert.equal(e.enviados.length, 0);
  assert.deepEqual(e.consumidos, []);
});

test("fallar el envío o la persistencia conserva el documento pendiente", async () => {
  for (const fallo of ["enviar", "registrar"] as const) {
    const e = escenario();
    await assert.rejects(solicitarRespuestaCarpeta(77, "adjunto-2", {
      ...e.deps, [fallo]: async () => { throw new Error("fallo simulado"); },
    }), /fallo simulado/);
    assert.equal(e.pendientes.length, 2);
    assert.deepEqual(e.consumidos, []);
  }
});

test("dos pulsaciones conservan ambas referencias y una respuesta se consume una sola vez", async () => {
  const e = escenario();
  await solicitarRespuestaCarpeta(77, "adjunto-2", e.deps);
  await solicitarRespuestaCarpeta(77, "adjunto-2", e.deps);
  assert.deepEqual(e.pendientes[1].respuestaMessageIds, [901, 902]);
  let veces = 0;
  for (const id of [901, 902]) await resolverRespuestaCarpeta(77, id, e.enviados[0], async () => { veces++; }, e.deps);
  assert.equal(veces, 1);
  assert.equal(e.pendientes.length, 1);
});

test("texto sin reply y replies ajenos no seleccionan una carpeta", async () => {
  const e = escenario();
  for (const id of [undefined, 12345]) {
    assert.equal(await resolverRespuestaCarpeta(77, id, "Otra pregunta", async () => assert.fail(), e.deps), false);
  }
  assert.deepEqual(e.consumidos, []);
});

test("el parser conserva el mensaje al que Telegram está respondiendo", () => {
  const chat = { id: 77, type: "private" };
  const incoming = parseIncomingUpdate({ update_id: 1, message: {
    message_id: 1000, chat, date: 0, text: "WOBA, FACTURAS/GASTOS",
    reply_to_message: { message_id: 901, chat, date: 0, text: PREFIJO_RESPUESTA_CARPETA },
  } });
  assert.equal(incoming?.replyToMessageId, 901);
  assert.equal(incoming?.replyToText, PREFIJO_RESPUESTA_CARPETA);
});
