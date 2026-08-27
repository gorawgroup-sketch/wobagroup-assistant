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

/** Un turno nuevo siempre empieza con un mensaje de usuario en texto plano (nunca un tool_result). */
function esInicioDeTurno(mensaje: Anthropic.MessageParam): boolean {
  return mensaje.role === "user" && typeof mensaje.content === "string";
}

/** Descarta el historial de un chat — vía de escape si algo lo deja en un estado que la API rechaza. */
export function limpiarHistorial(chatId: number): void {
  historiales.delete(chatId);
}

export function guardarHistorial(chatId: number, mensajes: Anthropic.MessageParam[]): void {
  if (mensajes.length <= MAX_MESSAGES) {
    historiales.set(chatId, mensajes);
    return;
  }

  // No se puede cortar en cualquier índice: un turno con herramientas deja
  // varios mensajes intermedios (assistant con tool_use + user con
  // tool_result) que dependen unos de otros — cortar a mitad de eso deja un
  // tool_result "huérfano" al principio del array, y la API de Anthropic lo
  // rechaza con 400 invalid_request_error (bug real visto en producción: una
  // conversación con muchas llamadas seguidas a buscar_documento_drive superó
  // el límite y tumbó el siguiente mensaje del usuario). Por eso se busca el
  // inicio de turno más cercano al límite en vez de cortar por índice fijo.
  const candidato = mensajes.length - MAX_MESSAGES;
  let inicio = candidato;
  while (inicio < mensajes.length && !esInicioDeTurno(mensajes[inicio])) {
    inicio++;
  }

  // Si no hay ningún inicio de turno válido en la cola candidata (un solo
  // turno con herramientas ocupó todo el margen), se conserva el array
  // completo — mejor un historial más largo de lo ideal que uno corrupto.
  historiales.set(chatId, inicio < mensajes.length ? mensajes.slice(inicio) : mensajes);
}
