import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";

/** Sheets, no un archivo local — ver core/jobs/cashflowAnnotationActionStore.ts para el bug real que esto corrige. */
export interface PendienteOrientacionCorreo {
  chatId: number;
  messageId: number;
  de: string;
  asunto: string;
  resumen: string;
  threadId?: string;
  messageIdHeader?: string;
  creadoEn: number;
  /** Ver PropuestaAccionCorreo.deColaCorreo — se propaga hasta acá para que continuarConOrientacion
   *  sepa si debe avanzar la cola al terminar. */
  deColaCorreo: boolean;
  /** Gmail message id interno; junto con threadId fija qué activo puede cerrarse. */
  mensajeId?: string;
}

export interface FilaOrientacionCorreoConIndice {
  rowIndex: number;
  pendiente: PendienteOrientacionCorreo;
}

export interface DependenciasOrientacionCorreo {
  leer: () => Promise<FilaOrientacionCorreoConIndice[]>;
  eliminar: (rowIndex: number) => Promise<void>;
  agregar: (pendiente: PendienteOrientacionCorreo) => Promise<void>;
}

export type ResultadoReclamoOrientacionCorreo =
  | { estado: "ninguna" }
  | { estado: "ambigua"; cantidad: number }
  | { estado: "consumida"; pendiente: PendienteOrientacionCorreo };

const TAB_NAME = "_pendientes_orientacion_correo";
const HEADERS = ["chatId", "messageId", "de", "asunto", "resumen", "threadId", "messageIdHeader", "creadoEn", "deColaCorreo", "mensajeId"];
const NUM_COLS = HEADERS.length;
const MUTEX_TRANSICIONES = "emailOrientationStore:transiciones";
// 24h — pedido explícito de Carlos (mismo criterio en todos los
// "pendiente_*", ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteOrientacionCorreo {
  return {
    chatId: Number(valores[0]),
    messageId: Number(valores[1]),
    de: valores[2],
    asunto: valores[3],
    resumen: valores[4],
    threadId: valores[5] || undefined,
    messageIdHeader: valores[6] || undefined,
    creadoEn: Number(valores[7]),
    deColaCorreo: valores[8] === "true",
    mensajeId: valores[9] || undefined,
  };
}

function objetoAFila(p: PendienteOrientacionCorreo): (string | number)[] {
  return [
    p.chatId,
    p.messageId,
    p.de,
    p.asunto,
    p.resumen,
    p.threadId ?? "",
    p.messageIdHeader ?? "",
    p.creadoEn,
    p.deColaCorreo ? "true" : "",
    p.mensajeId ?? "",
  ];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteOrientacionCorreo }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => f.pendiente.deColaCorreo || ahora - f.pendiente.creadoEn <= TTL_MS);
}

const dependenciasReales: DependenciasOrientacionCorreo = {
  leer: leerVigentes,
  eliminar: (rowIndex) => eliminarFila(TAB_NAME, rowIndex, HEADERS),
  agregar: async (pendiente) => {
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(pendiente));
  },
};

/**
 * Dos solicitudes de texto libre solo se consideran la misma cuando su
 * identidad estable coincide. `messageId` (Telegram) queda como respaldo
 * para filas antiguas creadas antes de persistir los ids de Gmail.
 */
export function mismaOrientacionCorreo(
  existente: Pick<PendienteOrientacionCorreo, "messageId" | "threadId" | "messageIdHeader" | "mensajeId">,
  nueva: Pick<PendienteOrientacionCorreo, "messageId" | "threadId" | "messageIdHeader" | "mensajeId">
): boolean {
  const mensajeExistente = existente.mensajeId?.trim();
  const mensajeNuevo = nueva.mensajeId?.trim();
  if (mensajeExistente && mensajeNuevo) return mensajeExistente === mensajeNuevo;

  const headerExistente = existente.messageIdHeader?.trim();
  const headerNuevo = nueva.messageIdHeader?.trim();
  if (headerExistente && headerNuevo) return headerExistente === headerNuevo;

  const threadExistente = existente.threadId?.trim();
  const threadNuevo = nueva.threadId?.trim();
  if (threadExistente && threadNuevo && existente.messageId === nueva.messageId) {
    return threadExistente === threadNuevo;
  }
  return existente.messageId === nueva.messageId;
}

/**
 * Guarda una orientación sin reemplazar silenciosamente otra solicitud del
 * mismo chat. Si ya existe una distinta, el callback recupera sus botones y
 * el operador puede terminar primero la orientación activa.
 */
export async function guardarPendienteOrientacionUnaVez(
  datos: Omit<PendienteOrientacionCorreo, "creadoEn">,
  dependencias: DependenciasOrientacionCorreo = dependenciasReales,
  claveMutex = MUTEX_TRANSICIONES
): Promise<void> {
  await conMutex(claveMutex, async () => {
    const vigentes = await dependencias.leer();
    const delChat = vigentes.filter((fila) => fila.pendiente.chatId === datos.chatId);
    if (delChat.some((fila) => !mismaOrientacionCorreo(fila.pendiente, datos))) {
      throw new Error("Ya hay una orientación pendiente para otro correo de este chat.");
    }
    // Un doble toque sobre el mismo correo ya quedó guardado. No hacemos un
    // delete→insert porque un fallo entre ambas operaciones perdería el retry.
    if (delChat.length > 0) return;
    await dependencias.agregar({ ...datos, creadoEn: Date.now() });
  });
}

export async function guardarPendienteOrientacionCorreo(
  datos: Omit<PendienteOrientacionCorreo, "creadoEn">
): Promise<void> {
  await guardarPendienteOrientacionUnaVez(datos);
}

/**
 * Reclama de forma atómica la única orientación del chat. Ante dos filas
 * (posible carrera entre réplicas o dato histórico), no elige una al azar ni
 * borra ninguna: el texto del operador no puede aplicarse al correo errado.
 */
export async function reclamarPendienteOrientacionUnaVez(
  chatId: number,
  dependencias: DependenciasOrientacionCorreo = dependenciasReales,
  claveMutex = MUTEX_TRANSICIONES
): Promise<ResultadoReclamoOrientacionCorreo> {
  return conMutex(claveMutex, async () => {
    const vigentes = await dependencias.leer();
    const delChat = vigentes.filter((fila) => fila.pendiente.chatId === chatId);
    if (delChat.length === 0) return { estado: "ninguna" };
    if (delChat.length > 1) return { estado: "ambigua", cantidad: delChat.length };

    const [fila] = delChat;
    await dependencias.eliminar(fila.rowIndex);
    return { estado: "consumida", pendiente: fila.pendiente };
  });
}

export async function reclamarPendienteOrientacionCorreo(
  chatId: number
): Promise<ResultadoReclamoOrientacionCorreo> {
  return reclamarPendienteOrientacionUnaVez(chatId);
}

export async function consumirPendienteOrientacionCorreo(
  chatId: number
): Promise<PendienteOrientacionCorreo | undefined> {
  const resultado = await reclamarPendienteOrientacionCorreo(chatId);
  return resultado.estado === "consumida" ? resultado.pendiente : undefined;
}

/** Restaura una orientación consumida si su ejecución falló antes de terminar. */
export async function restaurarPendienteOrientacionCorreo(
  pendiente: PendienteOrientacionCorreo
): Promise<void> {
  await conMutex(MUTEX_TRANSICIONES, async () => {
    const vigentes = await leerVigentes();
    const delChat = vigentes.filter((fila) => fila.pendiente.chatId === pendiente.chatId);
    // Si el mismo pendiente ya reapareció, restaurar sería un duplicado. Una
    // orientación distinta nunca se reemplaza; se conserva y se deja registro
    // de la anterior para que el reclamo seguro detecte la ambigüedad.
    if (delChat.some((fila) => mismaOrientacionCorreo(fila.pendiente, pendiente))) return;
    await agregarFila(
      TAB_NAME,
      NUM_COLS,
      HEADERS,
      objetoAFila({ ...pendiente, creadoEn: Date.now() })
    );
  });
}

/** Lectura sin consumir — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts). */
export async function obtenerPendienteOrientacionCorreoPorChat(
  chatId: number
): Promise<PendienteOrientacionCorreo | undefined> {
  const vigentes = await leerVigentes();
  return vigentes.find((f) => f.pendiente.chatId === chatId)?.pendiente;
}

/** Todas las orientaciones del chat. Aunque el flujo normal impide crear dos
 * distintas, devolver la colección completa evita que el watchdog dependa de
 * cuál fila aparezca primero ante datos históricos o una réplica concurrente. */
export async function obtenerPendientesOrientacionCorreoPorChat(
  chatId: number
): Promise<PendienteOrientacionCorreo[]> {
  const vigentes = await leerVigentes();
  return vigentes.filter((f) => f.pendiente.chatId === chatId).map((f) => f.pendiente);
}
