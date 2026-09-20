import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  claveReintentoWatchdog,
  coincideCorreoPendiente,
  coincideDecisionCorreoDeCola,
} from "./vigilarProcesamientoAtascado";

test("los reintentos pertenecen al mensaje exacto y no se heredan dentro del hilo", () => {
  assert.equal(claveReintentoWatchdog("thread-1", "message-1"), "thread-1:message-1");
  assert.notEqual(
    claveReintentoWatchdog("thread-1", "message-1"),
    claveReintentoWatchdog("thread-1", "message-2")
  );
});

test("una pendiente solo protege la identidad compuesta exacta", () => {
  assert.equal(
    coincideCorreoPendiente({ deColaCorreo: true, mensajeIdGmail: "msg-1", threadId: "thread-1" }, "msg-1", "thread-1"),
    true
  );
  assert.equal(
    coincideCorreoPendiente({ deColaCorreo: true, mensajeIdGmail: "msg-1", threadId: "thread-1" }, "msg-1", "thread-otro"),
    false
  );
  assert.equal(
    coincideCorreoPendiente({ deColaCorreo: true, mensajeIdGmail: "msg-original", threadId: "thread-1" }, "msg-nuevo", "thread-1"),
    false
  );
  assert.equal(
    coincideCorreoPendiente({ deColaCorreo: true, mensajeIdGmail: "msg-1" }, "msg-1", "thread-1"),
    false
  );
  assert.equal(
    coincideCorreoPendiente({ deColaCorreo: false, mensajeIdGmail: "msg-1", threadId: "thread-1" }, "msg-1", "thread-1"),
    false
  );
});

test("no coincide si ni el mensaje ni el hilo son el mismo", () => {
  assert.equal(
    coincideCorreoPendiente({ deColaCorreo: true, mensajeIdGmail: "msg-1", threadId: "thread-1" }, "msg-2", "thread-2"),
    false
  );
});

test("un origen indefinido nunca coincide", () => {
  assert.equal(coincideCorreoPendiente(undefined, "msg-1", "thread-1"), false);
});

test("una decisión de email solo protege el activo con ownership y ambos ids exactos", () => {
  const decision = { deColaCorreo: true, mensajeId: "msg-1", threadId: "thread-1" };
  assert.equal(coincideDecisionCorreoDeCola(decision, "msg-1", "thread-1"), true);
  assert.equal(coincideDecisionCorreoDeCola(decision, "msg-2", "thread-1"), false);
  assert.equal(coincideDecisionCorreoDeCola(decision, "msg-1", "thread-2"), false);
  assert.equal(coincideDecisionCorreoDeCola({ ...decision, threadId: undefined }, "msg-1", "thread-1"), false);
  assert.equal(coincideDecisionCorreoDeCola({ ...decision, mensajeId: undefined }, "msg-1", "thread-1"), false);
  assert.equal(
    coincideDecisionCorreoDeCola({ ...decision, deColaCorreo: false }, "msg-1", "thread-1"),
    false
  );
});

test("el watchdog consulta todas las decisiones intermedias que pueden mantener UNREAD el correo", async () => {
  const fuente = await readFile(join(process.cwd(), "core/jobs/vigilarProcesamientoAtascado.ts"), "utf8");
  for (const lectura of [
    "obtenerConciliacionesAmbiguasPendientesPorChat(chatId)",
    "obtenerPendientesOrientacionCorreoPorChat(chatId)",
    "obtenerOfertasResponderCorreoPorChat(chatId)",
    "obtenerBorradoresCorreoPorChat(chatId)",
    "obtenerPendientesCapturaEmpresaPorChat(chatId)",
  ]) {
    assert.match(fuente, new RegExp(lectura.replace(/[()]/g, "\\$&")));
  }
  assert.match(
    fuente,
    /conciliaciones\.some\(\(c\) => coincideDecisionCorreoDeCola\([\s\S]*?mensajeId: c\.mensajeIdGmail, threadId: c\.threadIdGmail/
  );
  assert.match(
    fuente,
    /conciliacionesAmbiguas\.some\(\(c\) => coincideDecisionCorreoDeCola\([\s\S]*?mensajeId: c\.mensajeIdGmail, threadId: c\.threadIdGmail/
  );
  assert.match(fuente, /orientacionesCorreo\.some\([\s\S]*coincideDecisionCorreoDeCola/);
  assert.match(fuente, /ofertasResponder\.some\([\s\S]*coincideDecisionCorreoDeCola/);
  assert.match(fuente, /borradoresCorreo\.some\([\s\S]*coincideDecisionCorreoDeCola/);
  assert.match(fuente, /capturasEmpresa\.some\([\s\S]*coincideDecisionCorreoDeCola/);
  assert.match(fuente, /clasifs\.some\(\(p\) => p\.messageId !== 0 && coincide\(p\.correoOrigen\)\)/);
  assert.match(fuente, /desambiguaciones\.some\([\s\S]*messageId[\s\S]*!== 0 && coincide\(d\.correoOrigen\)/);
});

test("el watchdog serializa inspección y reintento, conservando el mensaje exacto", async () => {
  const fuente = await readFile(join(process.cwd(), "core/jobs/vigilarProcesamientoAtascado.ts"), "utf8");
  assert.match(fuente, /return conCoordinadorCorreo\(\(\) => vigilarUnChatYaCoordinado\(chatId\)\)/);
  assert.match(fuente, /procesarSiguienteCorreoActivoYaCoordinado\(chatId\)/);
  assert.doesNotMatch(fuente, /obtenerUltimoMensajeDeHilo/);
  assert.match(
    fuente,
    /reencolarActivoParaReintento\(chatId, \{\s*threadId: activo\.id,\s*mensajeId: activo\.mensajeId,\s*\}/
  );

  const cierrePendiente = fuente.indexOf("if (activo.pendientesRestantes === 0)");
  const reencolado = fuente.indexOf("const reencolado = await reencolarActivoParaReintento", cierrePendiente);
  assert.ok(cierrePendiente >= 0 && reencolado > cierrePendiente);
  assert.match(
    fuente.slice(cierrePendiente, reencolado),
    /coincideIdentidadCorreoCola\(activo, identidadActiva\)[\s\S]*marcarMensajeComoLeido\(activo\.mensajeId\)[\s\S]*confirmarActivoResueltoTrasMarcarLeido\(chatId, identidadActiva\)/
  );
});
