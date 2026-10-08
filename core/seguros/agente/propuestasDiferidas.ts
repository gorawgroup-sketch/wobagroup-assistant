/**
 * Propuestas de Wobi Seguros que esperan a que se entregue la respuesta del turno.
 *
 * Caso real (Carlos, 2026-10-08): el agente mandó la propuesta «Aplicar / Cancelar» en mitad del turno; la respuesta de Wobi y
 * los mensajes de la cola de correo llegaron después y la dejaron enterrada. Carlos no la vio, Wobi decía «te la envié».
 * Regla del chat (#194, #240): lo que espera una decisión va AL FINAL. Por eso la propuesta no se crea ni se envía al
 * proponerla: se encola aquí y sale justo después de la respuesta (server.ts llama a `enviarPropuestasDiferidas`).
 *
 * Red de seguridad: si nadie la libera en `ESPERA_MAXIMA_MS` (un camino que no pasa por la entrega del chat), sale sola; una
 * propuesta nunca se pierde por quedarse esperando.
 */
export const ESPERA_MAXIMA_MS = 60_000;

type Envio = () => Promise<void>;
interface Entrada { envio: Envio; temporizador: ReturnType<typeof setTimeout> }

const porChat = new Map<number, Entrada[]>();

async function ejecutar(entrada: Entrada, chatId: number, avisar: (chatId: number, texto: string) => Promise<unknown>): Promise<boolean> {
  clearTimeout(entrada.temporizador);
  try {
    await entrada.envio();
    return true;
  } catch (error) {
    console.error("[propuestasDiferidas] No se pudo enviar la propuesta de Wobi Seguros:", error instanceof Error ? error.message : error);
    await avisar(chatId, "⚠️ Wobi Seguros preparó una propuesta pero no pude enviarla con sus botones. Pídesela de nuevo y la preparo otra vez.")
      .catch((e) => console.error("[propuestasDiferidas] Tampoco se pudo avisar del fallo:", e instanceof Error ? e.message : e));
    return false;
  }
}

async function avisoReal(chatId: number, texto: string): Promise<unknown> {
  const { sendTelegramMessage } = await import("../../telegram/client");
  return sendTelegramMessage(chatId, texto);
}

/** Deja la propuesta en cola. `envio` crea la fila y manda el mensaje con botones; no se ejecuta hasta la liberación. */
export function diferirPropuesta(chatId: number, envio: Envio, avisar: (chatId: number, texto: string) => Promise<unknown> = avisoReal): void {
  const entrada: Entrada = {
    envio,
    // Sin unref: el servidor está siempre vivo y, si el proceso se cierra, mejor que la propuesta salga a que se pierda.
    temporizador: setTimeout(() => { void liberarEntrada(chatId, entrada, avisar); }, ESPERA_MAXIMA_MS),
  };
  const cola = porChat.get(chatId) ?? [];
  cola.push(entrada);
  porChat.set(chatId, cola);
}

async function liberarEntrada(chatId: number, entrada: Entrada, avisar: (chatId: number, texto: string) => Promise<unknown>): Promise<void> {
  const cola = porChat.get(chatId);
  const idx = cola?.indexOf(entrada) ?? -1;
  if (!cola || idx < 0) return; // ya salió por otra vía
  cola.splice(idx, 1);
  if (cola.length === 0) porChat.delete(chatId);
  await ejecutar(entrada, chatId, avisar);
}

/** Envía, en orden, las propuestas en cola de ese chat. Devuelve cuántas salieron bien. Nunca lanza. */
export async function enviarPropuestasDiferidas(chatId: number, avisar: (chatId: number, texto: string) => Promise<unknown> = avisoReal): Promise<number> {
  const cola = porChat.get(chatId);
  if (!cola?.length) return 0;
  porChat.delete(chatId);
  let enviadas = 0;
  for (const entrada of cola) if (await ejecutar(entrada, chatId, avisar)) enviadas++;
  return enviadas;
}

export function hayPropuestasDiferidas(chatId: number): boolean {
  return (porChat.get(chatId)?.length ?? 0) > 0;
}
