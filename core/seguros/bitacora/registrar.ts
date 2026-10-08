import { invalidarComplementosSeguros } from "../estadoCerebro";
import { agregarEntradaBitacora, podarBitacora } from "./bitacoraStore";
import type { EntradaBitacora, EntradaNueva } from "./tipos";

export interface DepsRegistro {
  agregar(entrada: EntradaBitacora): Promise<void>;
  podar(): Promise<number>;
  ahora(): Date;
  nuevoId(): string;
  invalidar(): void;
}

const depsReales = (): DepsRegistro => ({
  agregar: agregarEntradaBitacora,
  podar: podarBitacora,
  ahora: () => new Date(),
  nuevoId: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  invalidar: invalidarComplementosSeguros,
});

/** La firma con la que las tareas reciben el registrador (así se sustituye por uno falso en las pruebas). */
export type Registrar = (entrada: EntradaNueva, opciones?: { podar?: boolean }) => Promise<boolean>;

/**
 * Deja constancia de lo que Wobi Seguros acaba de hacer. NUNCA lanza: la bitácora cuenta el trabajo, no lo condiciona; si Sheets falla, la tarea
 * ya hizo lo suyo y solo se pierde la línea (queda en el log del servidor). Devuelve si la línea se guardó.
 * `podar`: además de añadir, recorta las entradas más antiguas si la pestaña ha crecido de más (lo pide una sola tarea al día).
 */
export async function registrarActividad(entrada: EntradaNueva, opciones: { podar?: boolean } = {}, deps: DepsRegistro = depsReales()): Promise<boolean> {
  let guardada = false;
  try {
    await deps.agregar({ ...entrada, id: deps.nuevoId(), cuando: deps.ahora().toISOString() });
    guardada = true;
  } catch (error) {
    console.error("[bitacoraSeguros] No se pudo guardar la constancia (no crítico: la tarea ya hizo su trabajo):", error instanceof Error ? error.message : error);
  }
  try {
    deps.invalidar();
  } catch (error) {
    console.error("[bitacoraSeguros] No se pudo refrescar Cerebro (no crítico):", error instanceof Error ? error.message : error);
  }
  if (guardada && opciones.podar) {
    try {
      const borradas = await deps.podar();
      if (borradas > 0) console.log(`[bitacoraSeguros] ${borradas} entrada(s) antigua(s) retirada(s) de la bitácora.`);
    } catch (error) {
      console.error("[bitacoraSeguros] No se pudo podar la bitácora (no crítico):", error instanceof Error ? error.message : error);
    }
  }
  return guardada;
}
