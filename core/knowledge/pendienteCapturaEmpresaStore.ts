import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import type { IdentidadCorreoCola } from "../gmail/colaRevisionStore";
import { conMutex } from "../utils/asyncMutex";

export type EmpresaCaptura = "WOBA" | "EWORKS" | "Footprint" | "General";
export type EstadoPendienteCapturaEmpresa = "pendiente" | "registrando" | "registrada";

export interface PendienteCapturaEmpresa {
  chatId: number;
  messageId: number;
  texto: string;
  autor?: string;
  empresasSeleccionadas: EmpresaCaptura[];
  creadoEn: number;
  /**
   * true si esta captura vino de la cola de revisión de correo uno a uno
   * (ver core/gmail/colaRevisionStore.ts) — capturaEmpresaCallbackHandler.ts
   * lo usa para decidir si avanzar esa cola al confirmar/cancelar. Bug real
   * encontrado en auditoría: sin este marcador, confirmar/cancelar
   * CUALQUIER captura (ej. un "CAPTURA ..." escrito a mano, sin relación
   * con ningún correo) avanzaba/marcaba-como-leído el correo activo de la
   * cola si había uno en curso.
   */
  deColaCorreo?: boolean;
  /** Gmail thread que originó esta captura; evita cerrar otro activo horas después. */
  threadId?: string;
  /** Gmail message id interno que originó esta captura. */
  mensajeId?: string;
  /** Clave estable compartida con `_capturas` y con el decremento de la cola. */
  idempotencyKey?: string;
  /** Fase durable para reanudar tras reinicio sin repetir efectos. */
  estado?: EstadoPendienteCapturaEmpresa;
  /** Inicio de la última fase; permite recuperar un claim abandonado. */
  actualizadoEn?: number;
}

/** Sheets, no un archivo local — mismo bug real de fondo que cashflowAnnotationActionStore.ts (ver ese archivo para el detalle). */
const TAB_NAME = "_pendientes_captura_empresa";
const HEADERS = [
  "chatId",
  "messageId",
  "texto",
  "autor",
  "empresasSeleccionadas",
  "creadoEn",
  "deColaCorreo",
  "threadId",
  "mensajeId",
  "idempotencyKey",
  "estado",
  "actualizadoEn",
];
const NUM_COLS = HEADERS.length;
const MUTEX_CAPTURAS = "pendienteCapturaEmpresaStore:transiciones";

// Pedido explícito de Carlos, tras un caso real: procesa el correo/documentos
// entrantes por lotes y puede tardar horas en llegar a cada propuesta — con
// 30 min, botones de hace rato ya aparecían "expirados" antes de que le diera
// tiempo a tocarlos. 24 horas cubre un día completo de trabajo sin dejar
// crecer la pestaña indefinidamente (se sigue purgando después).
const TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_REGISTRO_MS = 2 * 60 * 1000;

function claveIdempotenciaCaptura(chatId: number, messageId: number): string {
  return `captura:${chatId}:${messageId}`;
}

function normalizarPendiente(pendiente: PendienteCapturaEmpresa): PendienteCapturaEmpresa {
  return {
    ...pendiente,
    idempotencyKey: pendiente.idempotencyKey?.trim() || claveIdempotenciaCaptura(pendiente.chatId, pendiente.messageId),
    estado: pendiente.estado ?? "pendiente",
    actualizadoEn: pendiente.actualizadoEn || pendiente.creadoEn || Date.now(),
  };
}

function filaAObjeto(valores: string[]): PendienteCapturaEmpresa {
  return normalizarPendiente({
    chatId: Number(valores[0]),
    messageId: Number(valores[1]),
    texto: valores[2],
    autor: valores[3] || undefined,
    empresasSeleccionadas: valores[4] ? (JSON.parse(valores[4]) as EmpresaCaptura[]) : [],
    creadoEn: Number(valores[5]),
    deColaCorreo: valores[6] === "true",
    threadId: valores[7] || undefined,
    mensajeId: valores[8] || undefined,
    idempotencyKey: valores[9] || undefined,
    estado: valores[10] === "registrando" || valores[10] === "registrada" ? valores[10] : "pendiente",
    actualizadoEn: Number(valores[11]) || Number(valores[5]) || 0,
  });
}

function objetoAFila(pOriginal: PendienteCapturaEmpresa): (string | number)[] {
  const p = normalizarPendiente(pOriginal);
  return [
    p.chatId,
    p.messageId,
    p.texto,
    p.autor ?? "",
    JSON.stringify(p.empresasSeleccionadas),
    p.creadoEn,
    p.deColaCorreo === true ? "true" : "",
    p.threadId ?? "",
    p.mensajeId ?? "",
    p.idempotencyKey ?? "",
    p.estado ?? "pendiente",
    p.actualizadoEn ?? p.creadoEn,
  ];
}

/** Identidad exacta que puede cerrar la cola; nunca devuelve un objeto vacío. */
export function identidadCorreoDeCaptura(
  pendiente: Pick<PendienteCapturaEmpresa, "threadId" | "mensajeId">
): IdentidadCorreoCola | undefined {
  const threadId = pendiente.threadId?.trim() || undefined;
  const mensajeId = pendiente.mensajeId?.trim() || undefined;
  // Una captura legacy con un solo id puede seguir mostrándose/responderse,
  // pero nunca autoriza el decremento ni Gmail READ de la cola actual.
  return threadId && mensajeId ? { threadId, mensajeId } : undefined;
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteCapturaEmpresa }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    // Una vez iniciado el efecto externo jamás vence en silencio: debe poder
    // reanudarse hasta confirmar registro y cierre de cola. Tampoco vence una
    // selección todavía pendiente que sea dueña de una unidad de la cola:
    // ese correo sigue UNREAD hasta que el operador confirme o cancele.
    .filter((f) =>
      f.pendiente.deColaCorreo ||
      f.pendiente.estado !== "pendiente" ||
      ahora - f.pendiente.creadoEn <= TTL_MS
    );
}

export interface FilaCapturaEmpresaConIndice {
  rowIndex: number;
  pendiente: PendienteCapturaEmpresa;
}

export interface DependenciasConsumoCapturaEmpresa {
  leer: () => Promise<FilaCapturaEmpresaConIndice[]>;
  eliminar: (rowIndex: number) => Promise<void>;
}

export interface DependenciasTransicionCapturaEmpresa {
  leer: () => Promise<FilaCapturaEmpresaConIndice[]>;
  actualizar: (rowIndex: number, pendiente: PendienteCapturaEmpresa) => Promise<void>;
  ahora?: () => number;
}

export type ResultadoClaimCapturaEmpresa =
  | { estado: "reclamada"; pendiente: PendienteCapturaEmpresa }
  | { estado: "registrada"; pendiente: PendienteCapturaEmpresa }
  | { estado: "en_proceso"; pendiente: PendienteCapturaEmpresa }
  | { estado: "ausente" };

/**
 * Guarda (reemplazando cualquier pendiente previo del MISMO mensaje —
 * chatId+messageId, no todo el chat) la selección en curso.
 *
 * Antes esto reemplazaba por chatId solo, así que dos capturas pendientes a
 * la vez en el mismo chat se pisaban entre sí — la segunda borraba en
 * silencio el "texto" de la primera aunque sus botones siguieran visibles
 * en Telegram, y confirmar la primera terminaba guardando el contenido de
 * la segunda. Con un solo trigger manual de CAPTURA esto casi nunca pasaba
 * en la práctica; con la evaluación automática de correos informativos
 * (ver revisarCorreoNuevo.ts) es realista que caigan 2+ en la misma
 * revisión horaria, así que ahora cada mensaje con botones tiene su propio
 * pendiente independiente.
 */
export async function guardarPendienteCapturaEmpresa(
  datos: Omit<PendienteCapturaEmpresa, "creadoEn">
): Promise<void> {
  await conMutex(MUTEX_CAPTURAS, async () => {
    const vigentes = await leerVigentes();
    const previo = vigentes.find((f) => f.pendiente.chatId === datos.chatId && f.pendiente.messageId === datos.messageId);
    const ahora = Date.now();
    const nueva = normalizarPendiente({ ...datos, creadoEn: ahora, actualizadoEn: datos.actualizadoEn ?? ahora });
    if (previo) {
      await actualizarFila(TAB_NAME, previo.rowIndex, NUM_COLS, objetoAFila(nueva));
      return;
    }
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(nueva));
  });
}

/** Lee el pendiente de ESE mensaje sin consumirlo (para toggles intermedios). undefined si no hay o venció. */
export async function obtenerPendienteCapturaEmpresa(
  chatId: number,
  messageId: number
): Promise<PendienteCapturaEmpresa | undefined> {
  return conMutex(MUTEX_CAPTURAS, async () => {
    const vigentes = await leerVigentes();
    return vigentes.find((f) => f.pendiente.chatId === chatId && f.pendiente.messageId === messageId)?.pendiente;
  });
}

/** Todos los pendientes vigentes de un chat (puede haber más de uno) — para el aviso de "te quedó algo sin confirmar". */
export async function obtenerPendientesCapturaEmpresaPorChat(chatId: number): Promise<PendienteCapturaEmpresa[]> {
  return conMutex(MUTEX_CAPTURAS, async () => {
    const vigentes = await leerVigentes();
    return vigentes.filter((f) => f.pendiente.chatId === chatId).map((f) => f.pendiente);
  });
}

/**
 * Reclama de forma atómica el pendiente de ESE mensaje. Dos callbacks del
 * mismo botón pueden leerlo a la vez, pero solo uno lo obtiene y elimina;
 * el segundo recibe undefined y no vuelve a ejecutar el efecto externo.
 */
export async function consumirPendienteCapturaUnaVez(
  chatId: number,
  messageId: number,
  dependencias: DependenciasConsumoCapturaEmpresa = {
    leer: leerVigentes,
    eliminar: (rowIndex) => eliminarFila(TAB_NAME, rowIndex, HEADERS),
  },
  claveMutex = MUTEX_CAPTURAS
): Promise<PendienteCapturaEmpresa | undefined> {
  return conMutex(claveMutex, async () => {
    const vigentes = await dependencias.leer();
    const fila = vigentes.find((f) => f.pendiente.chatId === chatId && f.pendiente.messageId === messageId);
    if (!fila) return undefined;
    await dependencias.eliminar(fila.rowIndex);
    return fila.pendiente;
  });
}

export async function consumirPendienteCapturaEmpresa(
  chatId: number,
  messageId: number
): Promise<PendienteCapturaEmpresa | undefined> {
  return consumirPendienteCapturaUnaVez(chatId, messageId);
}

/** Cancela solo una captura que todavía no inició ningún efecto externo. */
export async function cancelarPendienteCapturaEmpresa(
  chatId: number,
  messageId: number
): Promise<PendienteCapturaEmpresa | undefined> {
  return conMutex(MUTEX_CAPTURAS, async () => {
    const vigentes = await leerVigentes();
    const fila = vigentes.find((f) => f.pendiente.chatId === chatId && f.pendiente.messageId === messageId);
    if (!fila || (fila.pendiente.estado ?? "pendiente") !== "pendiente") return undefined;
    await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
    return fila.pendiente;
  });
}

/**
 * Claim durable de la fase de registro. Un segundo callback inmediato ve
 * `en_proceso`; tras un crash, el lease vence y el mismo botón puede reanudar.
 * Si la captura ya quedó registrada, devuelve esa fase para completar solo el
 * cierre idempotente de la cola.
 */
export async function reclamarPendienteCapturaParaConfirmar(
  chatId: number,
  messageId: number,
  dependencias: DependenciasTransicionCapturaEmpresa = {
    leer: leerVigentes,
    actualizar: (rowIndex, pendiente) => actualizarFila(TAB_NAME, rowIndex, NUM_COLS, objetoAFila(pendiente)),
  },
  claveMutex = MUTEX_CAPTURAS
): Promise<ResultadoClaimCapturaEmpresa> {
  return conMutex(claveMutex, async () => {
    const vigentes = await dependencias.leer();
    const fila = vigentes.find((f) => f.pendiente.chatId === chatId && f.pendiente.messageId === messageId);
    if (!fila) return { estado: "ausente" };
    const pendiente = normalizarPendiente(fila.pendiente);
    if (pendiente.estado === "registrada") return { estado: "registrada", pendiente };

    const ahora = dependencias.ahora?.() ?? Date.now();
    if (pendiente.estado === "registrando" && ahora - (pendiente.actualizadoEn ?? 0) < LEASE_REGISTRO_MS) {
      return { estado: "en_proceso", pendiente };
    }

    const reclamada = { ...pendiente, estado: "registrando" as const, actualizadoEn: ahora };
    await dependencias.actualizar(fila.rowIndex, reclamada);
    return { estado: "reclamada", pendiente: reclamada };
  });
}

export async function marcarPendienteCapturaRegistrada(
  pendiente: PendienteCapturaEmpresa
): Promise<PendienteCapturaEmpresa | undefined> {
  return conMutex(MUTEX_CAPTURAS, async () => {
    const vigentes = await leerVigentes();
    const fila = vigentes.find((f) =>
      f.pendiente.chatId === pendiente.chatId &&
      f.pendiente.messageId === pendiente.messageId &&
      f.pendiente.idempotencyKey === pendiente.idempotencyKey
    );
    if (!fila) return undefined;
    const registrada = normalizarPendiente({ ...fila.pendiente, estado: "registrada", actualizadoEn: Date.now() });
    await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila(registrada));
    return registrada;
  });
}

/** Repone el mismo pendiente si el efecto externo falló después del claim. */
export async function restaurarPendienteCapturaEmpresa(pendiente: PendienteCapturaEmpresa): Promise<void> {
  await guardarPendienteCapturaEmpresa({
    chatId: pendiente.chatId,
    messageId: pendiente.messageId,
    texto: pendiente.texto,
    autor: pendiente.autor,
    empresasSeleccionadas: pendiente.empresasSeleccionadas,
    deColaCorreo: pendiente.deColaCorreo,
    threadId: pendiente.threadId,
    mensajeId: pendiente.mensajeId,
    idempotencyKey: pendiente.idempotencyKey,
    estado: "pendiente",
    actualizadoEn: Date.now(),
  });
}

/**
 * Actualiza solo la selección si el pendiente sigue existiendo. Evita que un
 * toggle que llegó tarde lo vuelva a crear después de Confirmar/Cancelar.
 */
export async function actualizarEmpresasPendienteCaptura(
  chatId: number,
  messageId: number,
  empresasSeleccionadas: EmpresaCaptura[]
): Promise<PendienteCapturaEmpresa | undefined> {
  return conMutex(MUTEX_CAPTURAS, async () => {
    const vigentes = await leerVigentes();
    const fila = vigentes.find((f) => f.pendiente.chatId === chatId && f.pendiente.messageId === messageId);
    if (!fila) return undefined;
    const actualizada = { ...fila.pendiente, empresasSeleccionadas };
    await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila(actualizada));
    return actualizada;
  });
}

/** Elimina el pendiente de ESE mensaje sin ejecutar ningún efecto. */
export async function eliminarPendienteCapturaEmpresa(chatId: number, messageId: number): Promise<void> {
  await consumirPendienteCapturaEmpresa(chatId, messageId);
}
