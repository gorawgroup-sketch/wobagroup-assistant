import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

export type EmpresaCaptura = "WOBA" | "EWORKS" | "Footprint" | "General";

export interface PendienteCapturaEmpresa {
  chatId: number;
  messageId: number;
  texto: string;
  autor?: string;
  empresasSeleccionadas: EmpresaCaptura[];
  creadoEn: number;
}

/** Sheets, no un archivo local — mismo bug real de fondo que cashflowAnnotationActionStore.ts (ver ese archivo para el detalle). */
const TAB_NAME = "_pendientes_captura_empresa";
const HEADERS = ["chatId", "messageId", "texto", "autor", "empresasSeleccionadas", "creadoEn"];
const NUM_COLS = HEADERS.length;

// Pedido explícito de Carlos, tras un caso real: procesa el correo/documentos
// entrantes por lotes y puede tardar horas en llegar a cada propuesta — con
// 30 min, botones de hace rato ya aparecían "expirados" antes de que le diera
// tiempo a tocarlos. 24 horas cubre un día completo de trabajo sin dejar
// crecer la pestaña indefinidamente (se sigue purgando después).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteCapturaEmpresa {
  return {
    chatId: Number(valores[0]),
    messageId: Number(valores[1]),
    texto: valores[2],
    autor: valores[3] || undefined,
    empresasSeleccionadas: valores[4] ? (JSON.parse(valores[4]) as EmpresaCaptura[]) : [],
    creadoEn: Number(valores[5]),
  };
}

function objetoAFila(p: PendienteCapturaEmpresa): (string | number)[] {
  return [p.chatId, p.messageId, p.texto, p.autor ?? "", JSON.stringify(p.empresasSeleccionadas), p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteCapturaEmpresa }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

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
  const vigentes = await leerVigentes();
  const previo = vigentes.find((f) => f.pendiente.chatId === datos.chatId && f.pendiente.messageId === datos.messageId);
  if (previo) {
    await eliminarFila(TAB_NAME, previo.rowIndex, HEADERS);
  }
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila({ ...datos, creadoEn: Date.now() }));
}

/** Lee el pendiente de ESE mensaje sin consumirlo (para toggles intermedios). undefined si no hay o venció. */
export async function obtenerPendienteCapturaEmpresa(
  chatId: number,
  messageId: number
): Promise<PendienteCapturaEmpresa | undefined> {
  const vigentes = await leerVigentes();
  return vigentes.find((f) => f.pendiente.chatId === chatId && f.pendiente.messageId === messageId)?.pendiente;
}

/** Todos los pendientes vigentes de un chat (puede haber más de uno) — para el aviso de "te quedó algo sin confirmar". */
export async function obtenerPendientesCapturaEmpresaPorChat(chatId: number): Promise<PendienteCapturaEmpresa[]> {
  const vigentes = await leerVigentes();
  return vigentes.filter((f) => f.pendiente.chatId === chatId).map((f) => f.pendiente);
}

/** Elimina el pendiente de ESE mensaje (al confirmar o cancelar) sin devolverlo. */
export async function eliminarPendienteCapturaEmpresa(chatId: number, messageId: number): Promise<void> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.chatId === chatId && f.pendiente.messageId === messageId);
  if (!fila) return;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
}
