import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "./sheetsKeyValueStore";
import type { BloqueEscritura } from "./cashflowWrite";

/**
 * Pedido explícito de Carlos, tras un caso real (el propio sistema le avisó
 * que no tenía forma de corregir un valor ya escrito en el cashflow, solo de
 * registrar movimientos nuevos): igual que cualquier otra escritura real de
 * este sistema, la edición NUNCA se ejecuta directo — solo se propone (este
 * store) y se dispara tras aprobación explícita por botón (ver
 * edicionValorCashflowCallbackHandler.ts).
 */
export interface PendienteEdicionValorCashflow {
  id: string;
  chatId: number;
  messageId: number;
  bloque: BloqueEscritura;
  fila: number;
  clienteOConcepto: string;
  semana: string;
  valorActual: number;
  valorNuevo: number;
  /** Texto ya armado con el "antes" (para el mensaje de confirmación final, después de aplicar). */
  resumenAntes: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_edicion_valor_cashflow";
const HEADERS = ["id", "chatId", "messageId", "bloque", "fila", "clienteOConcepto", "semana", "valorActual", "valorNuevo", "resumenAntes", "creadoEn"];
const NUM_COLS = HEADERS.length;
// 24h — mismo criterio que el resto de "pendiente_*" de una sola decisión puntual (ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteEdicionValorCashflow | null {
  if (!valores[3] || !valores[4]) return null;
  return {
    id: valores[0],
    chatId: Number(valores[1]),
    messageId: Number(valores[2]),
    bloque: valores[3] as BloqueEscritura,
    fila: Number(valores[4]),
    clienteOConcepto: valores[5] ?? "",
    semana: valores[6] ?? "",
    valorActual: Number(valores[7]),
    valorNuevo: Number(valores[8]),
    resumenAntes: valores[9] ?? "",
    creadoEn: Number(valores[10]),
  };
}

function objetoAFila(p: PendienteEdicionValorCashflow): (string | number)[] {
  return [p.id, p.chatId, p.messageId, p.bloque, p.fila, p.clienteOConcepto, p.semana, p.valorActual, p.valorNuevo, p.resumenAntes, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteEdicionValorCashflow }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f): f is { rowIndex: number; pendiente: PendienteEdicionValorCashflow } => f.pendiente !== null)
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function crearPendienteEdicionValorCashflow(
  datos: Omit<PendienteEdicionValorCashflow, "id" | "creadoEn">
): Promise<PendienteEdicionValorCashflow> {
  const pendiente: PendienteEdicionValorCashflow = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(pendiente));
  return pendiente;
}

export async function actualizarMessageIdEdicionValorCashflow(id: string, messageId: number): Promise<void> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.id === id);
  if (!fila) return;
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila({ ...fila.pendiente, messageId }));
}

/** Devuelve la propuesta y ELIMINA su fila (aprobada o cancelada). */
export async function consumirPendienteEdicionValorCashflow(id: string): Promise<PendienteEdicionValorCashflow | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.id === id);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

/**
 * Lectura sin consumir, TODAS las de un chat (a diferencia de consumirPendienteEdicionValorCashflow,
 * de un solo id) — para el resumen diario de pendientes (ver core/jobs/resumenPendientesDiario.ts).
 * Mismo criterio que obtenerPendientesEdicionCompraHoldedPorChat (Holded): sin esto, una edición de
 * cashflow sin aprobar podía quedar días sin ninguna visibilidad hasta que expira sola a las 24h.
 */
export async function obtenerPendientesEdicionValorCashflowPorChat(chatId: number): Promise<PendienteEdicionValorCashflow[]> {
  const vigentes = await leerVigentes();
  return vigentes.filter((f) => f.pendiente.chatId === chatId).map((f) => f.pendiente);
}
