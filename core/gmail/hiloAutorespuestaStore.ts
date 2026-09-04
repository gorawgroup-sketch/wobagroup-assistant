import { leerFilas, agregarFila, actualizarFila } from "../google/sheetsKeyValueStore";

/**
 * Pedido explícito de Carlos: la aprobación de conversación automática (ver
 * autorespuestaContactoStore.ts) es POR CONTACTO, pero eso no basta — "puedes
 * recibir varios e-mails de la misma persona y no en todos debes responder
 * automáticamente, solamente en el identificado como conversación
 * automática". Este store agrega una segunda capa: cada HILO concreto de un
 * contacto aprobado necesita SU PROPIA aprobación, una sola vez, antes de
 * tratarse como conversación automática — un contacto aprobado con un hilo
 * nuevo (nunca visto) primero se pregunta, nunca se responde solo de una.
 */
export type EstadoHiloAutorespuesta = "pendiente" | "aprobado" | "rechazado";

export interface HiloAutorespuesta {
  threadId: string;
  chatId: number;
  de: string;
  asunto: string;
  estado: EstadoHiloAutorespuesta;
  creadoEn: number;
}

const TAB_NAME = "_hilos_autorespuesta";
const HEADERS = ["threadId", "chatId", "de", "asunto", "estado", "creadoEn"];
const NUM_COLS = HEADERS.length;

function filaAObjeto(valores: string[]): HiloAutorespuesta {
  return {
    threadId: valores[0] || "",
    chatId: Number(valores[1]) || 0,
    de: valores[2] || "",
    asunto: valores[3] || "",
    estado: (valores[4] === "aprobado" || valores[4] === "rechazado" ? valores[4] : "pendiente") as EstadoHiloAutorespuesta,
    creadoEn: Number(valores[5]) || 0,
  };
}

function objetoAFila(h: HiloAutorespuesta): (string | number)[] {
  return [h.threadId, h.chatId, h.de, h.asunto, h.estado, h.creadoEn];
}

async function leerTodos(): Promise<{ rowIndex: number; hilo: HiloAutorespuesta }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas.map((f) => ({ rowIndex: f.rowIndex, hilo: filaAObjeto(f.valores) }));
}

export async function obtenerEstadoHiloAutorespuesta(threadId: string): Promise<HiloAutorespuesta | undefined> {
  const todos = await leerTodos();
  return todos.find((f) => f.hilo.threadId === threadId)?.hilo;
}

/** Lectura sin consumir — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerPendientesHiloAutorespuestaPorChat(chatId: number): Promise<HiloAutorespuesta[]> {
  const todos = await leerTodos();
  return todos.filter((f) => f.hilo.chatId === chatId && f.hilo.estado === "pendiente").map((f) => f.hilo);
}

/** Crea el registro "pendiente" — no duplica si ya existía uno para este hilo. */
export async function crearPendienteAprobacionHilo(
  threadId: string,
  chatId: number,
  de: string,
  asunto: string
): Promise<void> {
  const existente = await obtenerEstadoHiloAutorespuesta(threadId);
  if (existente) return;

  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ threadId, chatId, de, asunto, estado: "pendiente", creadoEn: Date.now() }));
}

/**
 * Devuelve el registro actualizado, o undefined si no había ninguno para este threadId O si ya no
 * estaba "pendiente" — comparar-y-cambiar (nunca resuelve dos veces el mismo). Necesario porque
 * "autohilo_aprobar" es la decisión MÁS sensible del sistema (autorización permanente de envío
 * automático): sin este chequeo, dos taps rápidos sobre el mismo botón (doble-tap real, no
 * necesariamente malicioso) podrían leer ambos "pendiente" antes de que cualquiera escriba, y los
 * dos terminarían llamando a procesarHiloAutorespuestaAprobado — dos correos automáticos reales
 * enviados por el mismo hilo. Con este chequeo, solo el primero que de verdad transiciona
 * pendiente→resuelto devuelve el registro; cualquier llamada repetida ve que ya no está "pendiente"
 * y devuelve undefined, y el llamador (autorespuestaHiloCallbackHandler.ts) no hace nada más.
 */
export async function resolverHiloAutorespuesta(
  threadId: string,
  estado: "aprobado" | "rechazado"
): Promise<HiloAutorespuesta | undefined> {
  const todos = await leerTodos();
  const fila = todos.find((f) => f.hilo.threadId === threadId);
  if (!fila || fila.hilo.estado !== "pendiente") return undefined;

  const actualizado: HiloAutorespuesta = { ...fila.hilo, estado };
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila(actualizado));
  return actualizado;
}
