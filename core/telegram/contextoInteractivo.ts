import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marca el trabajo que nace de una acción del operador (un botón o un mensaje del chat).
 *
 * Caso real (Carlos, 2026-09-28 19:53 y 20:07): pulsó un botón mientras una revisión de correo
 * retenía el candado del buzón. Las operaciones de la cola esperaban ese candado solo 30 s, la
 * revisión duró dos minutos, y el botón terminó en «canceling statement due to lock timeout» con un
 * aviso genérico y alarmante. Una acción del operador no debe fallar por llegar mientras el sistema
 * trabaja: debe decir que está en espera y aplicarse sola.
 *
 * El contexto viaja por AsyncLocalStorage hasta donde se toma el candado (ver conCoordinadorCorreo),
 * sin pasar parámetros por las decenas de funciones intermedias. `avisarEspera` lo aporta quien
 * conoce el chat; aquí solo se garantiza que suene una vez por acción.
 */
interface Contexto { avisar: () => Promise<void>; avisado: boolean }
const almacen = new AsyncLocalStorage<Contexto>();

export function conContextoInteractivo<T>(avisarEspera: () => Promise<void>, tarea: () => Promise<T>): Promise<T> {
  return almacen.run({ avisar: avisarEspera, avisado: false }, tarea);
}

export function hayContextoInteractivo(): boolean {
  return almacen.getStore() !== undefined;
}

/** Avisa al operador de que su acción está en espera. Una sola vez por acción; nunca lanza. */
export async function avisarEsperaInteractiva(): Promise<void> {
  const contexto = almacen.getStore();
  if (!contexto || contexto.avisado) return;
  contexto.avisado = true;
  await contexto.avisar().catch((error) =>
    console.error("[interactivo] No se pudo avisar de la espera (no crítico):", error instanceof Error ? error.message : error)
  );
}
