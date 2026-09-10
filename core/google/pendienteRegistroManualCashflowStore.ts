import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "./sheetsKeyValueStore";
import type { BloqueEscritura } from "./cashflowWrite";

/**
 * Pedido explícito de Carlos, tras un caso real (pidió por chat agregar dos importes — sanción AEAT y
 * providencia de apremio de Alberto Comolli — al bloque "Pagos Extras" del cashflow, y el sistema
 * respondió que no tenía forma de crear una fila nueva desde el chat): la función de bajo nivel para
 * crear una fila nueva (registrarMovimientoEnSheet/registrarPendienteEnSheet, cashflowWrite.ts) ya
 * existe y ya cubre todos los bloques, pero deliberadamente nunca se conectó al chat directo — solo se
 * invoca hoy tras aprobar por botón una propuesta AUTOMÁTICA del comparativo Holded-vs-cashflow (ver
 * cashflowEscritura.ts, "ADVERTENCIA DE SEGURIDAD" en ese archivo). Este store es la pieza que faltaba:
 * igual que pendienteEdicionValorCashflowStore.ts para EDITAR un valor existente, este es su equivalente
 * para CREAR una fila nueva por pedido manual — nunca escribe nada por sí solo, solo guarda la
 * propuesta hasta que se aprueba con botón (ver registroManualCashflowCallbackHandler.ts).
 */
export interface PendienteRegistroManualCashflow {
  id: string;
  chatId: number;
  messageId: number;
  empresa: "WOBA" | "EWORKS";
  bloque: BloqueEscritura;
  clienteOConcepto: string;
  proyecto?: string;
  banco?: string;
  /** Vacía solo para pagos_pendientes_alberto/deudas_pendientes (saldos sin fecha de pago conocida). */
  semana?: string;
  valor: number;
  /** Texto ya armado del resumen (para los mensajes de cancelado/confirmado). */
  resumen: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_registro_manual_cashflow";
const HEADERS = [
  "id",
  "chatId",
  "messageId",
  "empresa",
  "bloque",
  "clienteOConcepto",
  "proyecto",
  "banco",
  "semana",
  "valor",
  "resumen",
  "creadoEn",
];
const NUM_COLS = HEADERS.length;
// 24h — mismo criterio que pendienteEdicionValorCashflowStore.ts (una sola decisión puntual, no una
// cola de turnos que deba sobrevivir más tiempo).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteRegistroManualCashflow | null {
  if (!valores[3] || !valores[4]) return null;
  return {
    id: valores[0],
    chatId: Number(valores[1]),
    messageId: Number(valores[2]),
    empresa: valores[3] as "WOBA" | "EWORKS",
    bloque: valores[4] as BloqueEscritura,
    clienteOConcepto: valores[5] ?? "",
    proyecto: valores[6] || undefined,
    banco: valores[7] || undefined,
    semana: valores[8] || undefined,
    valor: Number(valores[9]),
    resumen: valores[10] ?? "",
    creadoEn: Number(valores[11]),
  };
}

function objetoAFila(p: PendienteRegistroManualCashflow): (string | number)[] {
  return [
    p.id,
    p.chatId,
    p.messageId,
    p.empresa,
    p.bloque,
    p.clienteOConcepto,
    p.proyecto ?? "",
    p.banco ?? "",
    p.semana ?? "",
    p.valor,
    p.resumen,
    p.creadoEn,
  ];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteRegistroManualCashflow }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f): f is { rowIndex: number; pendiente: PendienteRegistroManualCashflow } => f.pendiente !== null)
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function crearPendienteRegistroManualCashflow(
  datos: Omit<PendienteRegistroManualCashflow, "id" | "creadoEn">
): Promise<PendienteRegistroManualCashflow> {
  const pendiente: PendienteRegistroManualCashflow = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(pendiente));
  return pendiente;
}

export async function actualizarMessageIdRegistroManualCashflow(id: string, messageId: number): Promise<void> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.id === id);
  if (!fila) return;
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila({ ...fila.pendiente, messageId }));
}

/** Devuelve la propuesta y ELIMINA su fila (aprobada o cancelada). */
export async function consumirPendienteRegistroManualCashflow(id: string): Promise<PendienteRegistroManualCashflow | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.id === id);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

/**
 * Lectura sin consumir, TODAS las de un chat — mismo criterio que
 * obtenerPendientesEdicionValorCashflowPorChat (pendienteEdicionValorCashflowStore.ts): sin esto, un
 * registro nuevo sin aprobar podía quedar días sin ninguna visibilidad hasta que expira solo a las 24h
 * (ver core/jobs/resumenPendientesDiario.ts).
 */
export async function obtenerPendientesRegistroManualCashflowPorChat(chatId: number): Promise<PendienteRegistroManualCashflow[]> {
  const vigentes = await leerVigentes();
  return vigentes.filter((f) => f.pendiente.chatId === chatId).map((f) => f.pendiente);
}
