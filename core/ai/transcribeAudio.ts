import { randomUUID } from "node:crypto";
import { autorizarLlamadaApi } from "./policy";
import { registrarUsoIA } from "../claude/costTracking";

export const MODELO_TRANSCRIPCION = "gpt-4o-mini-transcribe";
export const PROCESO_TRANSCRIPCION = "transcribir_voz_telegram";
export class ErrorNotaVoz extends Error {}

interface Dependencias {
  fetch: typeof fetch;
  autorizar: typeof autorizarLlamadaApi;
  registrar: typeof registrarUsoIA;
  apiKey: string | undefined;
}

/** Solo transcribe: las acciones siguen en el flujo de texto autenticado. */
export async function transcribirAudio(
  bytes: Buffer, nombre: string, mime: string, duracion: number, chatId: number,
  overrides: Partial<Dependencias> = {}
): Promise<string> {
  const deps: Dependencias = {
    fetch, autorizar: autorizarLlamadaApi, registrar: registrarUsoIA,
    apiKey: process.env.OPENAI_API_KEY, ...overrides,
  };
  if (!deps.apiKey?.trim()) throw new ErrorNotaVoz("La transcripción de voz todavía no está configurada. Puedes escribir el mensaje mientras se activa.");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new ErrorNotaVoz("El audio está vacío o supera 20 MB. Envía una nota más corta.");
  try { await deps.autorizar(PROCESO_TRANSCRIPCION); } catch {
    throw new ErrorNotaVoz("La transcripción está pausada por la configuración de consumo de IA. No ejecuté ninguna instrucción.");
  }
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), nombre);
  form.append("model", MODELO_TRANSCRIPCION);
  form.append("response_format", "json");
  form.append("language", "es");
  let response: Response;
  try {
    response = await deps.fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${deps.apiKey}` }, body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new ErrorNotaVoz("No pude completar la transcripción. No ejecuté ninguna instrucción de esta nota; vuelve a enviarla.");
  }
  if (!response.ok) throw new ErrorNotaVoz("El servicio de transcripción no pudo leer la nota. No ejecuté ninguna instrucción; inténtalo más tarde.");
  let result: { text?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid response");
    result = parsed as typeof result;
  } catch { throw new ErrorNotaVoz("La transcripción llegó incompleta. Envía de nuevo la nota de voz."); }
  const input = Number(result.usage?.input_tokens) || 0;
  const output = Number(result.usage?.output_tokens) || 0;
  // Tarifa oficial consultada 2026-09-15: 1,25/5 USD por millón de tokens.
  // Si falta usage, se registra la estimación publicada de 0,003 USD/minuto.
  const costoUSD = result.usage ? (input * 1.25 + output * 5) / 1_000_000 : duracion / 60 * 0.003;
  await deps.registrar(chatId, MODELO_TRANSCRIPCION, { input_tokens: input, output_tokens: output }, {
    proceso: PROCESO_TRANSCRIPCION, autenticacion: "openai_api_key", ejecucionId: randomUUID(), llamadaNumero: 1, costoUSD,
  }).catch(() => console.error("[voz] No se pudieron guardar las métricas de transcripción."));
  const text = typeof result.text === "string" ? result.text.trim() : "";
  if (!text || !/[\p{L}\p{N}]/u.test(text)) throw new ErrorNotaVoz("No distinguí palabras en la nota. Grábala de nuevo acercándote al micrófono.");
  // Evita ejecutar el comienzo de una orden cuya salida alcanzó el límite del modelo.
  if (output >= 1900 || text.length > 12_000) throw new ErrorNotaVoz("La nota es demasiado larga para procesarla completa. Divídela en mensajes más cortos.");
  return text;
}
