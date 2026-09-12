import test from "node:test";
import assert from "node:assert/strict";
import { createStreamingWobiSpeech } from "./wobiRealtimeSpeech.js";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Context extends EventTarget {
  state = "suspended"; currentTime = 0; sources = []; destination = {}; resumes = 0;
  async resume() { this.resumes++; this.state = "running"; this.dispatchEvent(new Event("statechange")); }
  async close() { this.state = "closed"; }
  createBuffer(_channels, samples, rate) { const data = new Float32Array(samples); return { duration: samples / rate, getChannelData: () => data, data }; }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(time) { this.startTime = time; }, stop() { this.stopped = true; }, finish() { this.onended?.(); } };
    this.sources.push(source); return source;
  }
}
const pcmHeaders = { "X-Audio-Format": "pcm-s16le", "X-Audio-Sample-Rate": "24000" };
const response = bytes => new Response(bytes, { headers: pcmHeaders });

test("enabling voice unlocks audio without transmitting chat text", async () => {
  const context = new Context(); let requests = 0;
  const player = createStreamingWobiSpeech({ makeContext: () => context, fetchAudio: async () => { requests++; } });
  await player.activate(); assert.equal(context.resumes, 1); assert.equal(requests, 0); player.dispose();
});

test("audio starts before the response stream finishes; muting aborts download and scheduled sound", async () => {
  const context = new Context(); const playing = deferred(); let stream; let requestSignal;
  const player = createStreamingWobiSpeech({ makeContext: () => context, onStateChange: state => { if (state === "playing") playing.resolve(); },
    fetchAudio: async (_url, {signal}) => {
      requestSignal = signal;
      return response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new Uint8Array(5760)); signal.addEventListener("abort", () => controller.error(signal.reason), { once:true }); } }));
    },
  });
  await player.activate(); const speaking = player.speak("Hola", {}); await playing.promise;
  assert.equal(context.sources.length, 1); assert.ok(stream); // Stream is deliberately still open.
  player.stop(); await speaking;
  assert.equal(requestSignal.aborted, true); assert.equal(context.sources[0].stopped, true);
});

test("prefetches following speech while playing and schedules contiguous audio across fragments", async () => {
  const context = new Context(); const second = deferred(); let requests = 0;
  const player = createStreamingWobiSpeech({ makeContext: () => context,
    fetchAudio: async () => { requests++; return response(new Uint8Array(5760)); },
    onStateChange: state => { if (state === "playing" && context.sources.length === 2) second.resolve(); },
  });
  await player.activate(); const speaking = player.speak("Una frase que mantiene una conversación natural. ".repeat(12), {});
  await second.promise;
  assert.equal(requests, 2);
  const [first, next] = context.sources;
  assert.equal(next.startTime, first.startTime + first.buffer.duration);
  for (const source of context.sources) source.finish();
  await speaking;
});

test("preserves PCM samples split at odd network byte boundaries", async () => {
  const context = new Context(); const playing = deferred();
  const player = createStreamingWobiSpeech({ makeContext: () => context,
    fetchAudio: async () => response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0])); c.enqueue(new Uint8Array([128, 255])); c.enqueue(new Uint8Array([127])); c.close(); } })),
    onStateChange: state => { if (state === "playing") playing.resolve(); },
  });
  await player.activate(); const speaking = player.speak("Hola", {}); await playing.promise;
  assert.deepEqual(Array.from(context.sources[0].buffer.data), [-1, 32767 / 32768]);
  context.sources[0].finish(); await speaking;
});

test("browser activation can resume once and later replies need no Play gesture", async () => {
  const context = new Context(); const blocked = deferred(); const playing = deferred();
  const player = createStreamingWobiSpeech({ makeContext: () => context, fetchAudio: async () => response(new Uint8Array(5760)),
    onStateChange: s => { if (s === "playing") playing.resolve(); },
  });
  const speaking = player.speak("Hola", {}, blocked.resolve); await blocked.promise;
  assert.equal(context.sources.length, 0); await player.activate(); await playing.promise;
  context.sources[0].finish(); await speaking;
  const playingAgain = deferred();
  // The context is reused; this reply starts with no additional activate().
  const second = player.speak("Otra respuesta", {});
  const poll = setInterval(() => { if (context.sources.length === 2) { clearInterval(poll); playingAgain.resolve(); } }, 1);
  await playingAgain.promise; context.sources[1].finish(); await second;
  assert.equal(context.resumes, 1);
});
