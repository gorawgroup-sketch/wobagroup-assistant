import assert from "node:assert/strict";
import test from "node:test";
import { prepararEntradaVoz } from "./voiceInput";
import { transcribirAudio } from "../ai/transcribeAudio";
import type { TelegramUpdate } from "./types";

const nota = (): TelegramUpdate => ({ update_id: 101, message: {
  message_id: 7, date: 1, from: { id: 9, is_bot: false, first_name: "Carlos" }, chat: { id: 22, type: "private" },
  voice: { file_id: "voice-file", file_unique_id: "unique", duration: 8, mime_type: "audio/ogg", file_size: 4 },
} });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("una nota conserva remitente, chat e identidad de entrega y pasa texto completo al flujo existente", async () => {
  const original = nota(); const before = structuredClone(original); let calls = 0;
  const result = await prepararEntradaVoz(original, { token: "test-token", apiKey: "test-key", enabled: true,
    fetch: async (url) => { calls++; return String(url).includes("/getFile?") ? json({ ok: true, result: { file_path: "voice/file.oga" } }) : new Response(new Uint8Array([1,2,3,4])); },
    transcribir: async (bytes, filename, mime, duration, chatId) => {
      assert.equal(bytes.length, 4); assert.equal(filename, "nota.ogg"); assert.equal(mime, "audio/ogg"); assert.equal(duration, 8); assert.equal(chatId, 22);
      return "Revisa Riba Smith por 6,30 dólares, no 6,29.";
    },
  });
  assert.equal(calls, 2); assert.deepEqual(original, before);
  assert.deepEqual(result, { ...before, message: { ...before.message!, text: "Revisa Riba Smith por 6,30 dólares, no 6,29." } });
});

test("texto escrito no usa descarga ni transcripción", async () => {
  const update = { update_id: 3, message: { ...nota().message!, voice: undefined, text: "hola" } };
  assert.equal(await prepararEntradaVoz(update, { fetch: async () => { throw new Error("no debe llamar"); } }), update);
});

test("configuración ausente, voz desactivada y notas largas se rechazan antes de descargar", async () => {
  for (const changes of [{ apiKey: "" }, { enabled: false }, { long: true }, { large: true }]) {
    const update = nota(); if (changes.long) update.message!.voice!.duration = 181;
    if (changes.large) update.message!.voice!.file_size = 21 * 1024 * 1024;
    let downloaded = false;
    await assert.rejects(prepararEntradaVoz(update, { apiKey: "key", enabled: true, token: "token", ...changes,
      fetch: async () => { downloaded = true; throw new Error("unexpected"); },
    }));
    assert.equal(downloaded, false); assert.equal(update.message!.text, undefined);
  }
});

test("descarga fallida no expone token ni ejecuta transcripción", async () => {
  await assert.rejects(prepararEntradaVoz(nota(), { apiKey: "key", token: "secret-token", enabled: true,
    fetch: async () => { throw new Error("https://api.telegram.org/botsecret-token/getFile"); },
    transcribir: async () => { assert.fail("no transcribir"); },
  }), error => error instanceof Error && !error.message.includes("secret-token") && error.message.includes("No pude descargar"));
});

test("límite de descarga real se aplica aunque no haya tamaño declarado", async () => {
  let transcribed = false;
  await assert.rejects(prepararEntradaVoz(nota(), { apiKey: "key", token: "token", enabled: true,
    fetch: async url => String(url).includes("getFile") ? json({ ok: true, result: { file_path: "voice/file.oga" } }) :
      new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20 * 1024 * 1024)); c.enqueue(new Uint8Array(1)); c.close(); } })),
    transcribir: async () => { transcribed = true; return "orden"; },
  }), /supera 20 MB/);
  assert.equal(transcribed, false);
});

const permitir = async () => ({ permitida: true, motivo: "test", soloObservacion: true });
test("API recibe audio multipart en español y registra consumo OpenAI sin guardar contenido", async () => {
  let authorized = false; let metrics: unknown[] = [];
  const text = await transcribirAudio(Buffer.from("audio"), "nota.ogg", "audio/ogg", 8, 22, {
    apiKey: "test-key", autorizar: async () => { authorized = true; return permitir(); },
    fetch: async (url, init) => {
      assert.equal(authorized, true); assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
      const body = init!.body as FormData; assert.equal(body.get("language"), "es"); assert.equal(body.get("response_format"), "json");
      assert.equal(body.get("model"), "gpt-4o-mini-transcribe"); assert.equal((body.get("file") as File).name, "nota.ogg");
      return json({ text: "Revisa los gastos de Nicolás.", usage: { input_tokens: 100, output_tokens: 10 } });
    }, registrar: async (...args) => { metrics = args; },
  });
  assert.equal(text, "Revisa los gastos de Nicolás.");
  assert.equal((metrics[3] as { autenticacion: string }).autenticacion, "openai_api_key");
  assert.equal((metrics[3] as { costoUSD: number }).costoUSD, 0.000175);
  assert.equal(JSON.stringify(metrics).includes("Nicolás"), false);
});

test("política de consumo bloquea antes de llamar al proveedor", async () => {
  let called = false;
  await assert.rejects(transcribirAudio(Buffer.from("audio"), "nota.ogg", "audio/ogg", 8, 22, {
    apiKey: "key", autorizar: async () => { throw new Error("disabled"); },
    fetch: async () => { called = true; return json({}); },
  }), /pausada/);
  assert.equal(called, false);
});

test("respuestas vacías, truncadas y errores no devuelven órdenes parciales", async () => {
  for (const response of [json({ text: " " }), json({ text: "..." }), json({ text: "Crear gasto", usage: { output_tokens: 2000 } }), new Response("secret", { status: 429 }), new Response("invalid")]) {
    await assert.rejects(transcribirAudio(Buffer.from("audio"), "nota.ogg", "audio/ogg", 8, 22, {
      apiKey: "key", autorizar: permitir, registrar: async () => {}, fetch: async () => response,
    }));
  }
});
