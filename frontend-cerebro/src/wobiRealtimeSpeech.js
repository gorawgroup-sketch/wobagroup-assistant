import { splitSpeechText } from "./wobiSpeech.js";

const SAMPLE_RATE = 24000;
const BLOCK_SAMPLES = 2880; // 120 ms of audio; enough to start before synthesis ends.

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function createStreamingWobiSpeech({
  fetchAudio = (...args) => fetch(...args),
  makeContext = () => {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error("Este navegador no admite la voz en tiempo real.");
    return new Context({ latencyHint: "interactive" });
  },
  onStateChange = () => {},
} = {}) {
  let context;
  let current;
  const getContext = () => context ??= makeContext();
  // Called directly from the voice toggle or Send gesture, before any fetch.
  const activate = () => {
    try { return getContext().resume(); } catch (error) { return Promise.reject(error); }
  };
  const stop = () => {
    if (!current) return;
    current.controller.abort();
    for (const source of current.sources) { source.onended = null; source.stop(); source.disconnect(); }
    current.sources.clear();
    current = undefined;
    onStateChange("idle");
  };
  const dispose = () => {
    stop();
    const old = context;
    context = undefined;
    old?.close().catch(() => {});
  };

  async function speak(text, headers, onBlocked = () => {}) {
    stop();
    const session = { controller: new AbortController(), sources: new Set(), nextStart: 0 };
    current = session;
    const signal = session.controller.signal;
    const report = state => { if (current === session) onStateChange(state); };
    let failed = false;
    try {
      const ctx = getContext();
      if (ctx.state !== "running") {
        report("blocked"); onBlocked();
        await new Promise((resolve, reject) => {
          const cleanup = () => { ctx.removeEventListener("statechange", changed); signal.removeEventListener("abort", aborted); };
          const changed = () => { if (ctx.state === "running") { cleanup(); resolve(); } };
          const aborted = () => { cleanup(); reject(signal.reason); };
          ctx.addEventListener("statechange", changed);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted(); else changed();
        });
      }
      signal.throwIfAborted();
      report("loading");
      const schedule = async bytes => {
        // Bound decoded audio ahead of playback; stop/mute interrupts this wait too.
        while (session.nextStart - ctx.currentTime > 10) await wait(50, signal);
        signal.throwIfAborted();
        const samples = bytes.length / 2;
        const buffer = ctx.createBuffer(1, samples, SAMPLE_RATE);
        const output = buffer.getChannelData(0);
        const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < samples; i++) output[i] = input.getInt16(i * 2, true) / 32768;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => { session.sources.delete(source); source.disconnect(); };
        session.sources.add(source);
        const start = Math.max(session.nextStart, ctx.currentTime + (session.nextStart ? 0.005 : 0.06));
        source.start(start);
        session.nextStart = start + buffer.duration;
        report("playing");
      };
      for (const texto of splitSpeechText(text)) {
        signal.throwIfAborted();
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
          response = await fetchAudio("/api/cerebro/voz/stream", {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ texto }), signal,
          });
          if (response.status !== 429 || attempt === 2) break;
          await response.body?.cancel();
          await wait(500 * (attempt + 1), signal);
        }
        if (!response.ok) throw new Error("No se pudo conectar con la voz de WOBi.");
        if (response.headers.get("X-Audio-Format") !== "pcm-s16le" || response.headers.get("X-Audio-Sample-Rate") !== String(SAMPLE_RATE) || !response.body) {
          throw new Error("El servicio de voz devolvió un formato inesperado.");
        }
        const reader = response.body.getReader();
        let pending = new Uint8Array(0);
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            bytes += value.length;
            if (bytes > 4_000_000) throw new Error("Respuesta de audio demasiado grande.");
            const combined = new Uint8Array(pending.length + value.length);
            combined.set(pending); combined.set(value, pending.length);
            let offset = 0;
            while (combined.length - offset >= BLOCK_SAMPLES * 2) {
              await schedule(combined.subarray(offset, offset + BLOCK_SAMPLES * 2));
              offset += BLOCK_SAMPLES * 2;
            }
            pending = combined.slice(offset);
          }
          if (!bytes || pending.length % 2) throw new Error("El audio llegó incompleto.");
          if (pending.length) await schedule(pending);
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        // Start fetching the next phrase while the previous audio is still playing.
      }
      while (session.sources.size) await wait(30, signal);
    } catch (error) {
      if (!signal.aborted) {
        failed = true;
        for (const source of session.sources) { source.onended = null; source.stop(); source.disconnect(); }
        session.sources.clear();
        report("error");
        throw error;
      }
    } finally {
      if (current === session) { if (!failed) report("idle"); current = undefined; }
    }
  }
  return { speak, activate, stop, dispose };
}
