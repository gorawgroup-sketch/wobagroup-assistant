import assert from "node:assert/strict";
import test from "node:test";
import { createWobiSpeech, splitSpeechText } from "./wobiSpeech.js";

class FakeAudio extends EventTarget {
  paused = false;
  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ""; }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const audioResponse = () => new Response(new Blob(["audio"], { type: "audio/mpeg" }), { headers: { "content-type": "audio/mpeg" } });

test("splits long replies without losing words or reading markdown syntax", () => {
  const text = "Wobi organiza la información con claridad. ".repeat(60).trim();
  const chunks = splitSpeechText(text);
  assert.ok(chunks.length > 1 && chunks.every(c => c.length <= 450));
  assert.equal(chunks.join(" "), text);
  assert.deepEqual(splitSpeechText("**Hola**, soy [Wobi](https://example.com)."), ["Hola, soy Wobi."]);
});

test("stopping cancels pending synthesis before any audio is played", async () => {
  let signal; let audioCreated = false;
  const player = createWobiSpeech({
    fetchAudio: (_url, options) => { signal = options.signal; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); },
    makeAudio: () => { audioCreated = true; return new FakeAudio(); },
  });
  const speaking = player.speak("Hola", {}); player.stop(); await speaking;
  assert.equal(signal.aborted, true); assert.equal(audioCreated, false);
});

test("a newer reply stops old playback and releases each audio URL", async () => {
  const audios = []; const revoked = []; const ready = [deferred(), deferred()];
  const player = createWobiSpeech({ fetchAudio: async () => audioResponse(),
    makeAudio: () => { const a = new FakeAudio(); audios.push(a); ready[audios.length - 1].resolve(); return a; },
    urls: { createObjectURL: () => `blob:${audios.length}`, revokeObjectURL: url => revoked.push(url) },
  });
  const first = player.speak("Primera", {}); await ready[0].promise;
  const second = player.speak("Segunda", {}); await ready[1].promise;
  assert.equal(audios[0].paused, true);
  audios[1].dispatchEvent(new Event("ended")); await Promise.all([first, second]);
  assert.equal(revoked.length, 2);
});

test("browser autoplay denial offers a direct resume of prepared audio", async () => {
  const audio = new FakeAudio(); let attempts = 0; let blocked = 0; const denied = deferred();
  audio.play = () => ++attempts === 1 ? Promise.reject(new DOMException("gesture needed", "NotAllowedError")) : Promise.resolve();
  const player = createWobiSpeech({ fetchAudio: async () => audioResponse(), makeAudio: () => audio,
    urls: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
  });
  const speaking = player.speak("Hola", {}, () => { blocked++; denied.resolve(); }); await denied.promise;
  assert.equal(blocked, 1); await player.resume();
  audio.dispatchEvent(new Event("ended")); await speaking;
  assert.equal(attempts, 2);
});
