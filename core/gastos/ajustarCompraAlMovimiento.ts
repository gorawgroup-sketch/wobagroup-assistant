import type { Empresa } from '../holded/client';
import { editarCompraHolded, obtenerCompraHoldedPorId, leerEstadoMovimiento, movimientoLibreParaConciliar, margenImporteAproximado } from '../holded/write';
import type { MovimientoBancarioCandidato } from '../holded/write';
const numero = (v: unknown) => {
  if (typeof v === 'number') return v;
  if (v == null || String(v).trim() === '') return NaN;
  const s = String(v).trim();
  return Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
};
const importeBanco = (v: unknown) => Number(v);
const depsDefault = { leerCompra: obtenerCompraHoldedPorId, leerMovimiento: leerEstadoMovimiento, editar: editarCompraHolded };
/** Reutiliza la edición durable y proporcional; nunca altera documentos con pagos ni otra divisa. */
export async function ajustarCompraAlMovimientoElegido(
  empresa: Empresa, gastoId: string, elegido: MovimientoBancarioCandidato, deps = depsDefault
): Promise<void> {
  const [compra, movimiento] = await Promise.all([
    deps.leerCompra(empresa, gastoId), deps.leerMovimiento(empresa, elegido.accountId, elegido.movementId, elegido.fecha),
  ]);
  if (!movimientoLibreParaConciliar(movimiento)) throw new Error('El movimiento elegido ya no está libre; no se ajustó el gasto.');
  const moneda = (compra.currency || 'EUR').toUpperCase();
  if (moneda !== elegido.moneda.toUpperCase() || moneda !== (movimiento?.currency || '').toUpperCase()) return;
  const total = numero(compra.total), cargo = Math.abs(importeBanco(movimiento?.amount));
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(cargo) || cargo <= 0 || importeBanco(movimiento?.amount) >= 0)
    throw new Error('Importes no válidos para ajustar el gasto.');
  if (Math.abs(cargo - Math.abs(elegido.monto)) > 0.005) throw new Error('El cargo cambió desde la selección; no se ajustó el gasto.');
  if (Math.abs(total - cargo) <= 0.005) return;
  if (Math.abs(total - cargo) > margenImporteAproximado(total)) throw new Error('La diferencia supera el margen aprendido; requiere ajustar el importe expresamente.');
  if ((compra.payments_detail ?? []).length || !Number.isFinite(numero(compra.payments_total)) || numero(compra.payments_total) !== 0)
    throw new Error('El gasto ya tiene pagos; no se cambia su importe automáticamente.');
  await deps.editar(empresa, gastoId, { montoNuevo: cargo }, {
    idempotencyKey: `ajuste-movimiento:${gastoId}:${elegido.movementId}:${Math.round(cargo * 100)}`,
    proceso: 'ajuste_importe_movimiento_elegido',
  });
}
