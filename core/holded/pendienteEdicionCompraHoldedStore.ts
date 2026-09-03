import { randomUUID } from "node:crypto";
import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import type { Empresa } from "./client";
import type { CambiosCompraHolded } from "./write";

/**
 * Pedido explícito de Carlos, tras un caso real (un gasto de McDonald's ya
 * creado en Holded con el monto y el número de documento mal, sin ninguna
 * forma de corregirlo salvo a mano o borrando y recreando): "necesito que
 * hagas lo que dices que no puedes hacer". Igual que cualquier otra
 * escritura real de este sistema, la edición NUNCA se ejecuta directo desde
 * la herramienta de Claude — solo se propone (este store) y se dispara tras
 * aprobación explícita por botón (ver edicionCompraHoldedCallbackHandler.ts).
 */
export interface PendienteEdicionCompraHolded {
  id: string;
  chatId: number;
  messageId: number;
  empresa: Empresa;
  purchaseId: string;
  cambios: CambiosCompraHolded;
  /** Texto ya armado con el "antes" (para el mensaje de confirmación final, después de aplicar). */
  resumenAntes: string;
  creadoEn: number;
}

const TAB_NAME = "_pendientes_edicion_compra_holded";
const HEADERS = ["id", "chatId", "messageId", "empresa", "purchaseId", "cambiosJSON", "resumenAntes", "creadoEn"];
const NUM_COLS = HEADERS.length;
// 24h — mismo criterio que el resto de "pendiente_*" (ver pendienteCapturaEmpresaStore.ts).
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(valores: string[]): PendienteEdicionCompraHolded | null {
  let cambios: CambiosCompraHolded;
  try {
    cambios = valores[5] ? JSON.parse(valores[5]) : null;
  } catch {
    return null;
  }
  if (!cambios) return null;
  return {
    id: valores[0],
    chatId: Number(valores[1]),
    messageId: Number(valores[2]),
    empresa: valores[3] as Empresa,
    purchaseId: valores[4],
    cambios,
    resumenAntes: valores[6] ?? "",
    creadoEn: Number(valores[7]),
  };
}

function objetoAFila(p: PendienteEdicionCompraHolded): (string | number)[] {
  return [p.id, p.chatId, p.messageId, p.empresa, p.purchaseId, JSON.stringify(p.cambios), p.resumenAntes, p.creadoEn];
}

async function leerVigentes(): Promise<{ rowIndex: number; pendiente: PendienteEdicionCompraHolded }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas
    .map((f) => ({ rowIndex: f.rowIndex, pendiente: filaAObjeto(f.valores) }))
    .filter((f): f is { rowIndex: number; pendiente: PendienteEdicionCompraHolded } => f.pendiente !== null)
    .filter((f) => ahora - f.pendiente.creadoEn <= TTL_MS);
}

export async function crearPendienteEdicionCompraHolded(
  datos: Omit<PendienteEdicionCompraHolded, "id" | "creadoEn">
): Promise<PendienteEdicionCompraHolded> {
  const pendiente: PendienteEdicionCompraHolded = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(pendiente));
  return pendiente;
}

export async function actualizarMessageIdEdicionCompraHolded(id: string, messageId: number): Promise<void> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.id === id);
  if (!fila) return;
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila({ ...fila.pendiente, messageId }));
}

/** Devuelve la propuesta y ELIMINA su fila (aprobada o cancelada). */
export async function consumirPendienteEdicionCompraHolded(id: string): Promise<PendienteEdicionCompraHolded | undefined> {
  const vigentes = await leerVigentes();
  const fila = vigentes.find((f) => f.pendiente.id === id);
  if (!fila) return undefined;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return fila.pendiente;
}

/**
 * Lectura sin consumir, TODAS las de un chat (a diferencia de los demás
 * "pendiente_*" de un solo slot por chat, acá puede haber varias propuestas
 * de edición vivas a la vez) — para el resumen diario de pendientes (ver
 * core/jobs/resumenPendientesDiario.ts). Bug real de auditoría: este store
 * se agregó sin conectarlo al resumen diario, así que una edición de Holded
 * sin aprobar podía quedar días sin ninguna visibilidad.
 */
export async function obtenerPendientesEdicionCompraHoldedPorChat(chatId: number): Promise<PendienteEdicionCompraHolded[]> {
  const vigentes = await leerVigentes();
  return vigentes.filter((f) => f.pendiente.chatId === chatId).map((f) => f.pendiente);
}
