import { randomUUID } from "node:crypto";
import type { BloqueEscritura } from "../google/cashflowWrite";

export interface Propuesta {
  id: string;
  empresa: "WOBA" | "EWORKS";
  bloqueSugerido: BloqueEscritura;
  clienteOConcepto: string;
  semana: string;
  valor: number;
  fechaMovimiento?: string;
  chatId: number;
  messageId: number;
  creadoEn: number;
}

/**
 * Store en memoria de propuestas pendientes de aprobación por Telegram.
 * NOTA: se pierde si el proceso se reinicia (redeploy, crash). Aceptable para
 * esta primera versión — las propuestas se regeneran en el siguiente run del
 * job semanal. Si esto se vuelve un problema, migrar a persistencia externa.
 */
const propuestas = new Map<string, Propuesta>();

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

export function crearPropuesta(datos: Omit<Propuesta, "id" | "creadoEn">): Propuesta {
  const propuesta: Propuesta = {
    ...datos,
    id: randomUUID().slice(0, 8),
    creadoEn: Date.now(),
  };
  propuestas.set(propuesta.id, propuesta);
  return propuesta;
}

export function obtenerPropuesta(id: string): Propuesta | undefined {
  const propuesta = propuestas.get(id);
  if (!propuesta) return undefined;

  if (Date.now() - propuesta.creadoEn > TTL_MS) {
    propuestas.delete(id);
    return undefined;
  }

  return propuesta;
}

/**
 * Elimina la propuesta del store (se llama al aprobarla o ignorarla, para que
 * no pueda procesarse dos veces si se pulsa el botón repetidamente).
 */
export function consumirPropuesta(id: string): Propuesta | undefined {
  const propuesta = obtenerPropuesta(id);
  if (propuesta) propuestas.delete(id);
  return propuesta;
}
