import { randomUUID } from "node:crypto";
import { autorizarLlamadaApi } from "../ai/policy";
import { registrarUsoIA } from "../claude/costTracking";

export const VOZ_WOBI = "marin";
export const MODELO_VOZ = "gpt-4o-mini-tts";
export const PROCESO_VOZ = "sintetizar_voz_wobi";
const INSTRUCCIONES = "Habla en español latinoamericano con acento mexicano suave y neutro, sin acento peninsular de España ni ceceo. Mantén la voz Marin con tono natural, cálido y conversacional. Pronunciación clara, velocidad tranquila. Lee exactamente el texto recibido, sin añadir comentarios. WOBi se pronuncia Uóbi.";
interface Dependencias {
  fetch: typeof fetch;
  autorizar: typeof autorizarLlamadaApi;
  registrar: typeof registrarUsoIA;
  apiKey: string | undefined;
  habilitada: boolean;
}

/** Un único proveedor y voz para MP3 y PCM, sin voz sustituta al fallar. */
export async function transmitirMarin(texto: string, signal: AbortSignal,
  emitir: (audio: Buffer) => Promise<void>, formato: "pcm" | "mp3",
  overrides: Partial<Dependencias> = {}): Promise<void> {
  const deps: Dependencias = {
    fetch, autorizar: autorizarLlamadaApi, registrar: registrarUsoIA,
    apiKey: process.env.OPENAI_API_KEY,
    habilitada: process.env.WOBI_OPENAI_VOICE_ENABLED === "true", ...overrides,
  };
  signal.throwIfAborted();
  if (!deps.habilitada || !deps.apiKey?.trim()) throw new Error("Voz Marin pendiente de activación");
  if (!texto.trim() || texto.length > 500) throw new Error("Texto de voz no válido");
  await deps.autorizar(PROCESO_VOZ);
  signal.throwIfAborted();
  const response = await deps.fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODELO_VOZ, voice: VOZ_WOBI,
      input: texto.replace(/\bWOBI\b/gi, "Uóbi").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " "),
      instructions: INSTRUCCIONES, response_format: formato, stream_format: "sse" }),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("No se pudo preparar la voz Marin");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "", bytes = 0, done = false;
  const id = randomUUID();
  const procesar = async (frame: string) => {
    signal.throwIfAborted();
    const data = frame.split("\n").filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") {
      if (!done) throw new Error("Cierre sin métricas finales");
      return;
    }
    const event = JSON.parse(data);
    if (done) throw new Error("Audio posterior al cierre");
    if (event.type === "speech.audio.delta") {
      if (typeof event.audio !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.audio)) throw new Error("Audio no válido");
      const audio = Buffer.from(event.audio, "base64");
      bytes += audio.length;
      if (bytes > 4_000_000) throw new Error("Audio demasiado grande");
      if (audio.length) await emitir(audio);
    } else if (event.type === "speech.audio.done") {
      const input = event.usage?.input_tokens, output = event.usage?.output_tokens;
      if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0 || !bytes) throw new Error("Síntesis sin audio o métricas completas");
      await deps.registrar(undefined, MODELO_VOZ, { input_tokens: input, output_tokens: output }, {
        proceso: PROCESO_VOZ, autenticacion: "openai_api_key", ejecucionId: id, llamadaNumero: 1,
        costoUSD: (input * 0.60 + output * 12) / 1_000_000,
      });
      done = true;
    } else throw new Error("Evento de síntesis inesperado");
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      pending = pending.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        await procesar(frame);
      }
      if (pending.length > 6_000_000) throw new Error("Evento demasiado grande");
      if (chunk.done) break;
    }
    if (pending.trim()) await procesar(pending);
    if (!done || (formato === "pcm" && bytes % 2)) throw new Error("Audio incompleto");
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock();
    if (!done && bytes) console.error("[voz] Síntesis parcial sin métricas finales; reconciliar consumo en OpenAI.");
  }
}
