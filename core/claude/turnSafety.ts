import type { EjecucionIA } from "../ai/policy";
import { TiempoMaximoExcedidoError } from "../utils/asyncTimeout";

export const MENSAJE_ACCION_INCIERTA = "No pude completar la respuesta después de iniciar una acción. " +
  "No he repetido el pedido automáticamente: la acción podría haberse realizado. " +
  "Consulta su estado antes de volver a pedir que se ejecute.";

export class TurnoConEfectosError extends Error {
  constructor(cause: unknown) {
    super(MENSAJE_ACCION_INCIERTA, { cause });
    this.name = "TurnoConEfectosError";
  }
}

/** Una escritura fallida también puede haber sido aceptada por el proveedor. */
export function impedirReinicioConEfectos(ejecucion: EjecucionIA, error: unknown): void {
  if (ejecucion.efectosIniciados) throw new TurnoConEfectosError(error);
}

export function mensajeFalloTurno(error: unknown): string {
  if (error instanceof TurnoConEfectosError) return MENSAJE_ACCION_INCIERTA;
  if (error instanceof TiempoMaximoExcedidoError) {
    return "Una consulta tardó más de lo permitido y he detenido este análisis. Puedes consultar el estado o intentar una nueva consulta de lectura.";
  }
  return "Wobi no pudo completar este mensaje. Comprueba el estado de cualquier acción solicitada antes de repetirla.";
}
