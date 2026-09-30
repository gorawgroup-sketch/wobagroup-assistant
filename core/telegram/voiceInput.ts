import type { TelegramUpdate } from "./types";
import { ErrorNotaVoz, transcribirAudio } from "../ai/transcribeAudio";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SECONDS = 180;
interface Dependencies {
  fetch: typeof fetch;
  token?: string;
  apiKey?: string;
  enabled: boolean;
  transcribir: typeof transcribirAudio;
}

async function leerAudioAcotado(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new ErrorNotaVoz("No pude descargar tu nota de voz. Vuelve a enviarla.");
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body.cancel();
    throw new ErrorNotaVoz("La nota supera 20 MB. Envía una más corta.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > MAX_BYTES) throw new ErrorNotaVoz("La nota supera 20 MB. Envía una más corta.");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!total) throw new ErrorNotaVoz("La nota de voz está vacía. Grábala de nuevo.");
  return Buffer.concat(chunks);
}

/** Se llama DESPUÉS de comprobar autorización y dentro de la entrega durable original. */
export async function prepararEntradaVoz(update: TelegramUpdate, overrides: Partial<Dependencies> = {}): Promise<TelegramUpdate> {
  const voice = update.message?.voice;
  if (!voice) return update;
  const deps: Dependencies = {
    fetch, token: process.env.TELEGRAM_BOT_TOKEN, apiKey: process.env.OPENAI_API_KEY,
    enabled: (process.env.TELEGRAM_VOICE_ENABLED ?? "true").trim().toLowerCase() === "true",
    transcribir: transcribirAudio, ...overrides,
  };
  if (!deps.enabled) throw new ErrorNotaVoz("Las notas de voz están desactivadas temporalmente. Puedes escribir tu instrucción.");
  if (!deps.apiKey?.trim()) throw new ErrorNotaVoz("La transcripción de voz todavía no está configurada. Puedes escribir el mensaje mientras se activa.");
  if (!Number.isFinite(voice.duration) || voice.duration <= 0 || voice.duration > MAX_SECONDS) throw new ErrorNotaVoz("Envía una nota de voz de hasta tres minutos para procesarla completa.");
  if ((voice.file_size ?? 0) > MAX_BYTES) throw new ErrorNotaVoz("La nota supera 20 MB. Envía una más corta.");
  if (!deps.token) throw new ErrorNotaVoz("No pude acceder al audio de Telegram. La configuración del bot necesita revisión.");
  let bytes: Buffer;
  let filename: string;
  let mime: string;
  try {
    const info = await deps.fetch(`https://api.telegram.org/bot${deps.token}/getFile?file_id=${encodeURIComponent(voice.file_id)}`, { signal: AbortSignal.timeout(20_000) });
    if (!info.ok) throw new Error("getFile failed");
    const data = await info.json() as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
    const filePath = data.result?.file_path;
    if (!data.ok || !filePath || !/^[a-zA-Z0-9_./-]+$/.test(filePath) || filePath.split("/").includes("..")) throw new Error("Invalid file path");
    if ((data.result?.file_size ?? 0) > MAX_BYTES) throw new ErrorNotaVoz("La nota supera 20 MB. Envía una más corta.");
    const ext = filePath.split(".").pop()?.toLowerCase();
    const formats: Record<string, string> = { oga: "audio/ogg", ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4" };
    if (!ext || !formats[ext]) throw new ErrorNotaVoz("No reconozco el formato de esta nota. Grábala con el micrófono de Telegram y envíala de nuevo.");
    mime = formats[ext]; filename = `nota.${ext === "oga" ? "ogg" : ext}`;
    bytes = await leerAudioAcotado(await deps.fetch(`https://api.telegram.org/file/bot${deps.token}/${filePath}`, { signal: AbortSignal.timeout(30_000) }));
  } catch (error) {
    if (error instanceof ErrorNotaVoz) throw error;
    // Los errores de fetch pueden incluir la URL con el token del bot: nunca propagarlos.
    throw new ErrorNotaVoz("No pude descargar tu nota de voz. No ejecuté ninguna instrucción; vuelve a enviarla.");
  }
  const text = await deps.transcribir(bytes, filename, mime, voice.duration, update.message!.chat.id, { apiKey: deps.apiKey });
  return { ...update, message: { ...update.message!, text } };
}
