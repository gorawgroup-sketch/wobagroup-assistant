import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

// Same voice and natural prosody as the published wobi-saludo-neural-v3.mp3.
export const WOBI_VOICE = "es-MX-DaliaNeural";
export const MAX_VOICE_TEXT = 500;

export function textoParaVoz(texto: string): string {
  return texto.replace(/\bWOBI\b/gi, "Uóbi")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export async function sintetizarVoz(texto: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const tts = new MsEdgeTTS();
  let onAbort: (() => void) | undefined;
  try {
    const synthesis = (async () => {
      await tts.setMetadata(WOBI_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      if (signal.aborted) { tts.close(); signal.throwIfAborted(); }
      const { audioStream } = tts.toStream(textoParaVoz(texto), { rate: "+0%", pitch: "+0Hz" });
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of audioStream) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > 2_000_000) throw new Error("Audio demasiado grande");
        chunks.push(Buffer.from(chunk));
      }
      if (!bytes) throw new Error("Audio vacío");
      return Buffer.concat(chunks);
    })();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => { tts.close(); reject(signal.reason || new Error("Síntesis cancelada")); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([synthesis, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    tts.close();
  }
}
