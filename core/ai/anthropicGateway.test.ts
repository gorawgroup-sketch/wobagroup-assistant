import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { configuracionSolicitudAnthropic, conLimiteSolicitud, crearMensajeAnthropic } from "./anthropicGateway";
import { TiempoMaximoExcedidoError } from "../utils/asyncTimeout";

test("presupuestos de espera por modelo y reintentos explícitos", () => {
  assert.deepEqual(configuracionSolicitudAnthropic("claude-haiku", {}), { timeout: 60_000, maxRetries: 0 });
  assert.equal(configuracionSolicitudAnthropic("claude-sonnet", {}).timeout, 120_000);
  assert.equal(configuracionSolicitudAnthropic("claude-opus", {}).timeout, 180_000);
  assert.equal(configuracionSolicitudAnthropic("claude-haiku", { WOBI_AI_HAIKU_TIMEOUT_MS: "" }).timeout, 60_000);
  assert.equal(configuracionSolicitudAnthropic("claude-sonnet", { WOBI_AI_MAX_RETRIES: "99" }).maxRetries, 2);
});

test("gateway desactiva reintentos SDK ante 503; no utiliza red real", async () => {
  let llamadas = 0;
  const sdk = new Anthropic({ apiKey: "test-not-a-secret", fetch: async () => {
    llamadas++;
    return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "test" } }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  } });
  await assert.rejects(crearMensajeAnthropic(sdk, { id: "test", proceso: "test", siguienteLlamada: () => 1 }, {
    model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "test" }],
  }));
  assert.equal(llamadas, 1);
});

test("SDK real recibe aborto si no llegan cabeceras", async () => {
  let abortado = false;
  const sdk = new Anthropic({ apiKey: "test-not-a-secret", fetch: async (_, init) => new Promise((_, reject) => {
    init!.signal!.addEventListener("abort", () => { abortado = true; reject(new Error("abort")); }, { once: true });
  }) });
  await assert.rejects(conLimiteSolicitud((signal) => sdk.messages.create({
    model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "test" }],
  }, { signal, maxRetries: 0 }), 30), TiempoMaximoExcedidoError);
  assert.equal(abortado, true);
});

test("aborto SDK también cubre cuerpo de respuesta bloqueado tras cabeceras", async () => {
  let abortado = false;
  const sdk = new Anthropic({ apiKey: "test-not-a-secret", fetch: async (_, init) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      init!.signal!.addEventListener("abort", () => {
        abortado = true;
        controller.error(new Error("abort body"));
      }, { once: true });
    } });
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  } });
  await assert.rejects(conLimiteSolicitud((signal) => sdk.messages.create({
    model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "test" }],
  }, { signal, maxRetries: 0 }), 30), TiempoMaximoExcedidoError);
  assert.equal(abortado, true);
});
