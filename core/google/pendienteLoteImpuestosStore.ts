import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "./sheetsKeyValueStore";
import type { EdicionImpuesto, NuevoImpuesto } from "./cashflowImpuestos";

/**
 * Un lote de altas y correcciones en las secciones de impuestos del cashflow, aprobable con un solo botón. Como
 * cualquier escritura real de este sistema, solo se propone aquí y se ejecuta tras la aprobación por botón
 * (loteImpuestosCallbackHandler.ts). Cada operación se verifica por relectura y el resultado se informa una a una.
 */
export type OperacionLoteImpuestos =
  | { tipo: "alta"; datos: NuevoImpuesto; descripcion: string }
  | { tipo: "correccion"; datos: EdicionImpuesto; descripcion: string };

export interface PendienteLoteImpuestos {
  id: string;
  chatId: number;
  messageId: number;
  titulo: string;
  operaciones: OperacionLoteImpuestos[];
  creadoEn: number;
}

const TAB_NAME = "_pendientes_lote_impuestos_cashflow";
const HEADERS = ["id", "chatId", "messageId", "titulo", "operacionesJSON", "creadoEn"];
const NUM_COLS = HEADERS.length;
const TTL_MS = 3 * 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteLoteImpuestos | null {
  if (!valores[0] || !valores[4]) return null;
  try {
    return { id: valores[0], chatId: Number(valores[1]), messageId: Number(valores[2]), titulo: valores[3] ?? "",
      operaciones: JSON.parse(valores[4]), creadoEn: Number(valores[5]) };
  } catch { return null; }
}
const objetoAFila = (p: PendienteLoteImpuestos): (string | number)[] =>
  [p.id, p.chatId, p.messageId, p.titulo, JSON.stringify(p.operaciones), p.creadoEn];

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteLoteImpuestos }[]> {
  const ahora = Date.now();
  return (await leerFilas(TAB_NAME, NUM_COLS, HEADERS))
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f): f is { rowIndex: number; pendiente: PendienteLoteImpuestos } => f.pendiente !== null && ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function crearPendienteLoteImpuestos(datos: Omit<PendienteLoteImpuestos, "id" | "creadoEn">): Promise<PendienteLoteImpuestos> {
  const pendiente = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(pendiente));
  return pendiente;
}

export async function actualizarMessageIdLoteImpuestos(id: string, messageId: number): Promise<void> {
  const fila = (await leerVigentes()).find((f) => f.pendiente.id === id);
  if (fila) await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila({ ...fila.pendiente, messageId }));
}

/** Devuelve el lote y ELIMINA su fila (aprobado o cancelado): un lote se ejecuta una sola vez. */
export async function consumirPendienteLoteImpuestos(id: string): Promise<PendienteLoteImpuestos | undefined> {
  const fila = (await leerVigentes()).find((f) => f.pendiente.id === id);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}
