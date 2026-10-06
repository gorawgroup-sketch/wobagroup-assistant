import { invalidarComplementosSeguros } from "../estadoCerebro";
import type { PagoConfirmado } from "../vigilante/cruces";
import { importeEnEur } from "../vigilante/tipos";
import { aplicarConfirmacionAPagos, type CambiosPorConfirmacion } from "./confirmacion";
import { actualizarPagoSeguro, agregarPagoSeguro, leerPagosSeguros } from "./pagosStore";
import type { PagoSeguro, PagoSeguroConFila } from "./tipos";

export interface DepsAlConfirmarPago {
  leerPagos(): Promise<PagoSeguroConFila[]>;
  actualizar(pago: PagoSeguroConFila, cambios: Partial<PagoSeguro>): Promise<unknown>;
  agregar(pago: PagoSeguro): Promise<boolean>;
  invalidarCerebro(): void;
}

const depsReales: DepsAlConfirmarPago = {
  leerPagos: leerPagosSeguros,
  actualizar: actualizarPagoSeguro,
  agregar: agregarPagoSeguro,
  invalidarCerebro: invalidarComplementosSeguros,
};

/**
 * Gancho del vigilante: un pago confirmado en el banco marca como «pagado» su fila del calendario (con el importe real) y genera el
 * siguiente pago de la serie. Si no hay fila que corresponda (p. ej. el recibo suelto de un suplemento) no hace nada.
 */
export async function actualizarCalendarioConPagoConfirmado(pago: PagoConfirmado, hoy: string, deps: DepsAlConfirmarPago = depsReales): Promise<CambiosPorConfirmacion> {
  const pagos = await deps.leerPagos();
  const importe = Math.abs(importeEnEur(pago.movimiento) ?? pago.movimiento.importe);
  const cambios = aplicarConfirmacionAPagos(
    pagos,
    { polizaIds: pago.polizas.map((p) => p.id), fecha: pago.movimiento.fecha, importe, movimientoId: pago.movimiento.id, cuenta: pago.movimiento.cuenta },
    hoy
  );
  for (const { id, cambios: c } of cambios.actualizaciones) {
    const fila = pagos.find((p) => p.id === id);
    if (fila) await deps.actualizar(fila, c);
  }
  for (const nuevo of cambios.nuevos) await deps.agregar(nuevo);
  if (cambios.actualizaciones.length > 0 || cambios.nuevos.length > 0) deps.invalidarCerebro();
  return cambios;
}
