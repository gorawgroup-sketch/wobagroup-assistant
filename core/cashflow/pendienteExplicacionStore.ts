import { agregarFila, eliminarFila, leerFilas } from "../google/sheetsKeyValueStore";

/**
 * «Esperando que el operador explique por qué este movimiento ya está en el cashflow» (botón «📝 Explicar» del aviso de movimientos sin
 * registrar). Un solo hueco por chat, como el resto de «pendiente_*». TTL CORTO (15 min) y, si el mensaje del operador es una respuesta
 * al mensaje de WOBI, solo vale si responde a ESE mensaje: así una conversación normal posterior nunca se interpreta como explicación.
 */
export interface PendienteExplicacion { chatId: number; propuestaId: string; promptMessageId: number; creadoEn: number }

const TAB = "_pendientes_explicacion_cashflow";
const HEADERS = ["chatId", "propuestaId", "promptMessageId", "creadoEn"];
export const TTL_EXPLICACION_MS = 15 * 60 * 1000;

const aObjeto = (v: string[]): PendienteExplicacion => ({ chatId: Number(v[0]), propuestaId: v[1] ?? "", promptMessageId: Number(v[2]), creadoEn: Number(v[3]) });

export function explicacionVigente(p: PendienteExplicacion, replyToMessageId: number | undefined, ahora = Date.now()): boolean {
  if (ahora - p.creadoEn > TTL_EXPLICACION_MS) return false;
  return replyToMessageId === undefined || replyToMessageId === p.promptMessageId;
}

export async function guardarPendienteExplicacion(d: Omit<PendienteExplicacion, "creadoEn">): Promise<void> {
  const filas = await leerFilas(TAB, HEADERS.length, HEADERS);
  const previo = filas.find((f) => Number(f.valores[0]) === d.chatId);
  if (previo) await eliminarFila(TAB, previo.rowIndex, HEADERS);
  await agregarFila(TAB, HEADERS.length, HEADERS, [d.chatId, d.propuestaId, d.promptMessageId, Date.now()]);
}

/** Devuelve (y elimina) la explicación esperada de este chat si sigue vigente y el mensaje responde a la pregunta correcta. */
export async function consumirPendienteExplicacion(chatId: number, replyToMessageId?: number): Promise<PendienteExplicacion | undefined> {
  const filas = await leerFilas(TAB, HEADERS.length, HEADERS);
  const fila = filas.find((f) => Number(f.valores[0]) === chatId);
  if (!fila) return undefined;
  const p = aObjeto(fila.valores);
  if (Date.now() - p.creadoEn > TTL_EXPLICACION_MS) { await eliminarFila(TAB, fila.rowIndex, HEADERS); return undefined; }
  if (!explicacionVigente(p, replyToMessageId)) return undefined; // respondió a otro mensaje: no es la explicación, se conserva el hueco
  await eliminarFila(TAB, fila.rowIndex, HEADERS);
  return p;
}
