import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { MPEGDecoder } from "mpg123-decoder";

// Same voice and natural prosody as the published wobi-saludo-neural-v3.mp3.
export const WOBI_VOICE = "es-MX-DaliaNeural";
export const MAX_VOICE_TEXT = 500;
export const VOICE_SAMPLE_RATE = 24_000;

export function textoParaVoz(texto: string): string {
  return texto.replace(/\bWOBI\b/gi, "Uóbi")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function transmitirAudio(
  texto: string, signal: AbortSignal, emitir: (audio: Buffer) => Promise<void>, pcm: boolean,
): Promise<void> {
  signal.throwIfAborted();
  const tts = new MsEdgeTTS();
  const decoder = pcm ? new MPEGDecoder() : undefined;
  let onAbort: (() => void) | undefined;
  try {
    const synthesis = (async () => {
      await decoder?.ready;
      signal.throwIfAborted();
      await tts.setMetadata(WOBI_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      if (signal.aborted) { tts.close(); signal.throwIfAborted(); }
      const { audioStream } = tts.toStream(textoParaVoz(texto), { rate: "+0%", pitch: "+0Hz" });
      let bytes = 0;
      let emitted = 0;
      for await (const chunk of audioStream) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > 2_000_000) throw new Error("Audio demasiado grande");
        let output = Buffer.from(chunk);
        if (decoder) {
          const decoded = decoder.decode(output);
          if (decoded.errors.length) throw new Error("Audio no válido");
          if (!decoded.samplesDecoded) continue;
          if (decoded.sampleRate !== VOICE_SAMPLE_RATE || !decoded.channelData.length) throw new Error("Formato de voz inesperado");
          output = Buffer.alloc(decoded.samplesDecoded * 2);
          // mpg123 exposes two identical channels even for the mono voice MP3.
          const samples = decoded.channelData[0];
          for (let i = 0; i < samples.length; i++) {
            output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * (samples[i] < 0 ? 32768 : 32767)), i * 2);
          }
        }
        emitted += output.length;
        if (emitted > 4_000_000) throw new Error("Audio demasiado grande");
        await emitir(output);
      }
      if (!emitted) throw new Error("Audio vacío");
    })();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => { tts.close(); reject(signal.reason || new Error("Síntesis cancelada")); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    await Promise.race([synthesis, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    tts.close();
    // Initialization must finish before releasing the WASM allocation.
    if (decoder) { await decoder.ready; decoder.free(); }
  }
}

export async function sintetizarVoz(texto: string, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await transmitirAudio(texto, signal, async audio => { chunks.push(audio); }, false);
  return Buffer.concat(chunks);
}

export function transmitirVozPcm(texto: string, signal: AbortSignal, emitir: (audio: Buffer) => Promise<void>): Promise<void> {
  return transmitirAudio(texto, signal, emitir, true);
}
