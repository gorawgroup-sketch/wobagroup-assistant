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
  // Mobile networks may pause delivery longer than one 120 ms PCM block.
  bufferBeforePlayback = () => typeof navigator !== "undefined" &&
    (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)),
  onStateChange = () => {},
  onAudioLevel = null,
} = {}) {
  let context;
  let current;
  let activated = false;
  const getContext = () => context ??= makeContext();
  // Called directly from the voice toggle or Send gesture, before any fetch.
  const activate = () => {
    activated = true;
    try { return getContext().resume(); } catch (error) { return Promise.reject(error); }
  };
  const stop = () => {
    if (!current) return;
    current.controller.abort();
    current.removeStateListener?.();
    clearTimeout(current.recoveryTimer);
    clearTimeout(current.levelTimer);
    current.analyser?.disconnect();
    onAudioLevel?.(0);
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
    let recovering = false;
    try {
      const ctx = getContext();
      const recover = () => {
        if (signal.aborted || current !== session || ctx.state === "running" || recovering || !activated || (session.recoveryAttempts || 0) >= 4) return;
        recovering = true;
        session.recoveryAttempts = (session.recoveryAttempts || 0) + 1;
        // A microphone session can interrupt a context already unlocked by a tap.
        Promise.resolve().then(() => { if (!signal.aborted && current === session) return ctx.resume(); }).catch(() => {}).finally(() => {
          recovering = false;
          // iOS may release the microphone route after recognition.onend.
          if (!signal.aborted && current === session && ctx.state !== "running" && session.recoveryAttempts < 4) {
            clearTimeout(session.recoveryTimer);
            session.recoveryTimer = setTimeout(recover, 150 * 2 ** (session.recoveryAttempts - 1));
          }
        });
      };
      const changed = () => {
        if (signal.aborted || current !== session) return;
        if (ctx.state === "running") { clearTimeout(session.recoveryTimer); session.recoveryAttempts = 0; report(session.sources.size ? "playing" : "loading"); }
        else { report("blocked"); onBlocked(); recover(); }
      };
      ctx.addEventListener("statechange", changed);
      session.removeStateListener = () => ctx.removeEventListener("statechange", changed);
      const ensureRunning = async () => {
        if (ctx.state === "running") return;
        report("blocked"); onBlocked();
        await new Promise((resolve, reject) => {
          const cleanup = () => { ctx.removeEventListener("statechange", resumed); signal.removeEventListener("abort", aborted); };
          const resumed = () => {
            if (ctx.state === "running") { cleanup(); resolve(); }
            else if (ctx.state === "closed") { cleanup(); reject(new Error("El audio se cerró. Vuelve a activar la voz.")); }
          };
          const aborted = () => { cleanup(); reject(signal.reason); };
          ctx.addEventListener("statechange", resumed);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted(); else { resumed(); recover(); }
        });
      };
      await ensureRunning();
      signal.throwIfAborted();
      report("loading");
      if (onAudioLevel && ctx.createAnalyser) {
        session.analyser = ctx.createAnalyser();
        session.analyser.fftSize = 256;
        session.analyser.connect(ctx.destination);
        const levels = new Uint8Array(session.analyser.fftSize);
        const sample = () => {
          if (signal.aborted || current !== session) return;
          session.analyser.getByteTimeDomainData(levels);
          const rms = Math.sqrt(levels.reduce((sum, value) => sum + ((value-128)/128)**2, 0)/levels.length);
          onAudioLevel(Math.min(1, rms*4));
          session.levelTimer = setTimeout(sample, 50);
        };
        sample();
      }
      const schedule = async bytes => {
        await ensureRunning();
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
        source.connect(session.analyser || ctx.destination);
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
        const buffered = bufferBeforePlayback();
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            bytes += value.length;
            if (bytes > 4_000_000) throw new Error("Respuesta de audio demasiado grande.");
            if (buffered) { chunks.push(value); continue; }
            const combined = new Uint8Array(pending.length + value.length);
            combined.set(pending); combined.set(value, pending.length);
            let offset = 0;
            while (combined.length - offset >= BLOCK_SAMPLES * 2) {
              await schedule(combined.subarray(offset, offset + BLOCK_SAMPLES * 2));
              offset += BLOCK_SAMPLES * 2;
            }
            pending = combined.slice(offset);
          }
          if (buffered) {
            pending = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) { pending.set(chunk, offset); offset += chunk.length; }
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
      session.removeStateListener?.();
      clearTimeout(session.recoveryTimer);
      clearTimeout(session.levelTimer);
      session.analyser?.disconnect();
      if (current === session) onAudioLevel?.(0);
      if (current === session) { if (!failed) report("idle"); current = undefined; }
    }
  }
  return { speak, activate, stop, dispose };
}
