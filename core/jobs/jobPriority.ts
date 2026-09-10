import { obtenerEstadoPlanificadorHerramientas } from "../tools/scheduler";
import { enteroAcotado } from "../utils/asyncTimeout";

export interface ResultadoEsperaCron {
  esperoMs: number;
  agotada: boolean;
}

interface OpcionesEsperaCron {
  estado?: () => { activas: number; pendientes: number };
  esperar?: (ms: number) => Promise<void>;
  ahora?: () => number;
  graciaMs?: number;
  intervaloMs?: number;
}

const esperarReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Los crons ceden al chat solo antes de empezar. No se cancela ni se pausa un
 * job ya iniciado: hacerlo podría dejar una operación externa a medias.
 */
export async function esperarPrioridadInteractiva(
  opciones: OpcionesEsperaCron = {}
): Promise<ResultadoEsperaCron> {
  const estado = opciones.estado ?? obtenerEstadoPlanificadorHerramientas;
  const esperar = opciones.esperar ?? esperarReal;
  const ahora = opciones.ahora ?? Date.now;
  const graciaMs = opciones.graciaMs ?? enteroAcotado(
    process.env.WOBI_CRON_INTERACTIVE_GRACE_MS, 30_000, 0, 120_000
  );
  const intervaloMs = opciones.intervaloMs ?? 250;
  const inicio = ahora();

  if (graciaMs <= 0) return { esperoMs: 0, agotada: false };

  while (true) {
    const actual = estado();
    if (actual.activas === 0 && actual.pendientes === 0) {
      return { esperoMs: Math.max(0, ahora() - inicio), agotada: false };
    }
    const restante = graciaMs - (ahora() - inicio);
    if (restante <= 0) break;
    await esperar(Math.min(intervaloMs, restante));
  }

  return { esperoMs: Math.max(0, ahora() - inicio), agotada: true };
}
