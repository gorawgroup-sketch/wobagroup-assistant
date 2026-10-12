import test from "node:test";
import assert from "node:assert/strict";
import { transmitirMarin } from "./sintesis";

const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = event({ type: "speech.audio.delta", audio: Buffer.from([0, 0, 1, 0]).toString("base64") });
const done = event({ type: "speech.audio.done", usage: { input_tokens: 100, output_tokens: 200 } });
const permit = async () => ({ permitida: true, motivo: "test", soloObservacion: false });
const registrar = async () => {};

test("Marin uses existing server credentials, streaming and exact reported token cost", async () => {
  let request: RequestInit | undefined;
  const metrics: unknown[][] = [];
  const bytes: Buffer[] = [];
  const stream = new ReadableStream({ start(c) {
    const raw = Buffer.from(delta + done);
    // Real SSE frames can be split even within CRLF and JSON strings.
    for (let i = 0; i < raw.length; i += 7) c.enqueue(raw.subarray(i, i + 7));
    c.close();
  } });
  await transmitirMarin('Hola, WOBi. A & B', new AbortController().signal,
    async b => { bytes.push(b); }, "pcm", {
      habilitada: true, apiKey: "test-secret", autorizar: permit,
      fetch: async (_url, init) => { request = init; return new Response(stream); },
      registrar: async (...args) => { metrics.push(args); },
    });
  const body = JSON.parse(request!.body as string);
  assert.equal(body.voice, "marin"); assert.equal(body.stream_format, "sse");
  assert.equal(body.response_format, "pcm"); assert.equal(body.input, 'Hola, Uóbi. A & B');
  assert.equal(metrics.length, 1);
  assert.equal((metrics[0][3] as { costoUSD: number }).costoUSD, 0.00246);
  assert.equal((metrics[0][3] as { proceso: string }).proceso, "sintetizar_voz_wobi");
  assert.deepEqual(Buffer.concat(bytes), Buffer.from([0, 0, 1, 0]));
});

test("no provider call before activation, credentials, valid text and spending authorization", async () => {
  let calls = 0;
  const defaults = { habilitada: true, apiKey: "test", registrar, autorizar: permit,
    fetch: async () => { calls++; return new Response(delta + done); } };
  for (const overrides of [{ habilitada: false }, { apiKey: undefined },
    { autorizar: async () => { throw new Error("budget"); } }]) {
    await assert.rejects(transmitirMarin("Hola", new AbortController().signal, async () => {}, "mp3", { ...defaults, ...overrides }));
  }
  await assert.rejects(transmitirMarin("a".repeat(501), new AbortController().signal, async () => {}, "pcm", defaults));
  assert.equal(calls, 0);
});

test("provider refusal, truncated audio and absent metrics never succeed or record zero", async () => {
  let metrics = 0;
  for (const response of [new Response("private error", { status: 403 }), new Response(delta),
    new Response(delta + event({ type: "speech.audio.done" }))]) {
    await assert.rejects(transmitirMarin("Hola", new AbortController().signal, async () => {}, "mp3", {
      habilitada: true, apiKey: "test", autorizar: permit,
      registrar: async () => { metrics++; }, fetch: async () => response,
    }));
  }
  assert.equal(metrics, 0);
});

test("cancellation propagates to provider and never switches voices", async () => {
  const controller = new AbortController();
  let upstream: AbortSignal | null | undefined;
  await assert.rejects(transmitirMarin("Hola", controller.signal,
    async () => { controller.abort(); }, "pcm", {
      habilitada: true, apiKey: "test", autorizar: permit, registrar,
      fetch: async (_url, init) => { upstream = init?.signal; return new Response(delta + done); },
    }));
  assert.equal(upstream, controller.signal); assert.equal(upstream?.aborted, true);
});
