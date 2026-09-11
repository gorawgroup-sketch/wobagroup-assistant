export function splitSpeechText(text) {
  let rest = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ")
    .replace(/[*_`#]/g, "").replace(/\|/g, ", ").replace(/\s+/g, " ").trim();
  const chunks = [];
  while (rest.length > 450) {
    const candidate = rest.slice(0, 450);
    const sentence = [...candidate.matchAll(/[.!?;]\s/g)].at(-1);
    let end = sentence && sentence.index > 100 ? sentence.index + 1 : candidate.lastIndexOf(" ");
    if (end < 100) end = /[\uD800-\uDBFF]/.test(candidate.at(-1)) ? 449 : 450;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function createWobiSpeech({
  fetchAudio = (...args) => fetch(...args),
  makeAudio = () => new Audio(),
  urls = URL,
} = {}) {
  let current;
  const stop = () => { current?.controller.abort(); };
  const resume = () => current?.audio?.play() ?? Promise.resolve();

  async function speak(text, headers, onBlocked = () => {}) {
    stop();
    const session = { controller: new AbortController(), audio: null };
    current = session;
    const signal = session.controller.signal;
    try {
      for (const texto of splitSpeechText(text)) {
        signal.throwIfAborted();
        const response = await fetchAudio("/api/cerebro/voz", {
          method: "POST", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ texto }), signal,
        });
        if (!response.ok) throw new Error("No se pudo preparar la voz de WOBi. Puedes volver a intentarlo.");
        if (!response.headers.get("content-type")?.startsWith("audio/")) throw new Error("El servicio de voz no devolvió audio.");
        const blob = await response.blob();
        signal.throwIfAborted();
        if (!blob.size) throw new Error("El servicio de voz devolvió audio vacío.");
        const url = urls.createObjectURL(blob);
        const audio = makeAudio();
        session.audio = audio;
        audio.src = url;
        try {
          await new Promise((resolve, reject) => {
            const finish = (error) => {
              audio.removeEventListener("ended", ended);
              audio.removeEventListener("error", failed);
              signal.removeEventListener("abort", cancelled);
              if (error) reject(error); else resolve();
            };
            const ended = () => finish();
            const failed = () => finish(new Error("No se pudo reproducir la voz de WOBi."));
            const cancelled = () => { audio.pause(); finish(signal.reason); };
            audio.addEventListener("ended", ended);
            audio.addEventListener("error", failed);
            signal.addEventListener("abort", cancelled, { once: true });
            if (signal.aborted) { cancelled(); return; }
            audio.play().catch(error => {
              if (signal.aborted) return;
              // Keep the prepared audio so a user gesture can resume it directly.
              if (error.name === "NotAllowedError") onBlocked();
              else finish(error);
            });
          });
        } finally {
          audio.pause();
          audio.removeAttribute("src");
          urls.revokeObjectURL(url);
          session.audio = null;
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (current === session) current = null;
    }
  }
  return { speak, stop, resume };
}
