import type Anthropic from "@anthropic-ai/sdk";

// Historial en memoria por chat de Telegram, para que preguntas de seguimiento
// ("envíale ese link a Carlos") tengan contexto de lo que se habló antes. Vive
// solo en memoria del proceso (se reinicia en cada redeploy) — es aceptable
// para continuidad conversacional, a diferencia de estado que debe sobrevivir
// redeploys (propuestas, borradores, checkpoints), que se guardan aparte.
const MAX_MESSAGES = 20;

const historiales = new Map<number, Anthropic.MessageParam[]>();

export function obtenerHistorial(chatId: number): Anthropic.MessageParam[] {
  return historiales.get(chatId) ?? [];
}

export function guardarHistorial(chatId: number, mensajes: Anthropic.MessageParam[]): void {
  historiales.set(chatId, mensajes.slice(-MAX_MESSAGES));
}
