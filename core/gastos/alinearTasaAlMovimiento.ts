import type { Empresa } from "../holded/client";
import {
  editarCompraHolded,
  leerEstadoMovimiento,
  movimientoLibreParaConciliar,
  obtenerCompraHoldedPorId,
} from "../holded/write";
import type { MovimientoBancarioCandidato } from "../holded/write";
import { compraTienePagos } from "../holded/recuperarConciliacionCompra";

/** La tasa implícita del cargo elegido nunca se aleja más de esto de la del gasto: más allá es un emparejamiento dudoso. */
const DESVIACION_MAXIMA_TASA = 0.3;

/** Importes de Holded: "16992,00" (a la española) o "-4.57" (decimal plano). */
function numero(valor: unknown): number {
  if (typeof valor === "number") return valor;
  if (valor == null || String(valor).trim() === "") return NaN;
  const texto = String(valor).trim();
  return Number(texto.includes(",") ? texto.replace(/\./g, "").replace(",", ".") : texto);
}

const centimos = (importe: number) => Math.round(importe * 100);

export type ResultadoAlineacionTasa =
  | { estado: "no_aplica"; motivo: string }
  | { estado: "ya_alineada"; montoEur: number; tasa: number }
  | { estado: "ajustada"; montoEur: number; tasaAnterior: number; tasaNueva: number; monedaDocumento: string };

const depsDefault = {
  leerCompra: obtenerCompraHoldedPorId,
  leerMovimiento: leerEstadoMovimiento,
  editar: editarCompraHolded,
};

/**
 * Antes de conciliar un gasto en otra moneda (COP, MXN…) contra un cargo en EUR que el operador eligió a mano, fija el
 * tipo de cambio del gasto a la tasa REAL implícita de ese cargo (importe nativo ÷ cargo en EUR). Así el equivalente en
 * EUR del gasto vale exactamente lo que salió del banco y la conciliación queda sin diferencia: ni pago "extra" por
 * cambio de divisa ni saldo residual (pedido explícito de Carlos, 2026-09-28: «ajuste la tasa de cambio para que la
 * conciliación quede sin ninguna diferencia»). Es la misma técnica que ya usa el flujo automático al crear el gasto
 * (monedaRegistroPlanAuto): el importe original del comprobante no cambia, solo la conversión a EUR.
 *
 * Falla cerrado: si el gasto ya tiene pagos, el cargo dejó de estar libre o cambió, o la tasa resultante se aleja de la
 * del gasto más de DESVIACION_MAXIMA_TASA, lanza y no escribe nada. Devuelve `no_aplica` (sin escribir) cuando no se
 * puede derivar el equivalente en EUR con certeza (gasto en EUR, misma moneda o cuenta que no es EUR).
 */
export async function alinearTasaCambioAlMovimientoElegido(
  empresa: Empresa,
  gastoId: string,
  elegido: MovimientoBancarioCandidato,
  deps = depsDefault
): Promise<ResultadoAlineacionTasa> {
  const [compra, movimiento] = await Promise.all([
    deps.leerCompra(empresa, gastoId),
    deps.leerMovimiento(empresa, elegido.accountId, elegido.movementId, elegido.fecha),
  ]);
  if (!movimientoLibreParaConciliar(movimiento)) {
    throw new Error("El movimiento elegido ya no está libre; no se ajustó la tasa de cambio del gasto.");
  }

  const monedaDocumento = (compra.currency || "EUR").toUpperCase().trim();
  const monedaMovimiento = (movimiento?.currency || "EUR").toUpperCase().trim();
  if (monedaDocumento === "EUR") return { estado: "no_aplica", motivo: "el gasto ya está en EUR" };
  if (monedaDocumento === monedaMovimiento) return { estado: "no_aplica", motivo: "gasto y cargo están en la misma moneda" };
  if (monedaMovimiento !== "EUR") {
    return { estado: "no_aplica", motivo: `el cargo está en ${monedaMovimiento}: no se conoce su equivalente exacto en EUR` };
  }

  const importeMovimiento = numero(movimiento?.amount);
  const cargo = Math.abs(importeMovimiento);
  const total = numero(compra.total);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(cargo) || cargo <= 0 || importeMovimiento >= 0) {
    throw new Error("Importes no válidos para ajustar la tasa de cambio del gasto.");
  }
  if (Math.abs(cargo - Math.abs(elegido.monto)) > 0.005) {
    throw new Error("El cargo cambió desde la selección; no se ajustó la tasa de cambio del gasto.");
  }
  if (compraTienePagos(compra)) {
    throw new Error("El gasto ya tiene pagos; no se cambia su tasa de cambio automáticamente.");
  }

  const tasaActual = numero(compra.currency_change);
  const tasaNueva = Number((total / cargo).toFixed(6));
  if (!Number.isFinite(tasaNueva) || tasaNueva <= 0) throw new Error("No se pudo calcular la tasa de cambio del cargo elegido.");
  if (Number.isFinite(tasaActual) && tasaActual > 0 && Math.abs(tasaNueva / tasaActual - 1) > DESVIACION_MAXIMA_TASA) {
    throw new Error(
      `La tasa implícita del cargo (${tasaNueva}) se aleja demasiado de la del gasto (${tasaActual}); no se ajustó nada.`
    );
  }

  // Ya cuadra al céntimo con la tasa actual: un reintento no vuelve a editar.
  if (Number.isFinite(tasaActual) && tasaActual > 0 && centimos(total / tasaActual) === centimos(cargo)) {
    return { estado: "ya_alineada", montoEur: cargo, tasa: tasaActual };
  }

  const editada = await deps.editar(empresa, gastoId, { tasaCambioNueva: tasaNueva }, {
    idempotencyKey: `ajuste-tasa-movimiento:${gastoId}:${elegido.movementId}:${Math.round(tasaNueva * 1e6)}`,
    proceso: "ajuste_tasa_cambio_movimiento_elegido",
  });

  // Holded devuelve la tasa redondeada a dos decimales: se comprueba con ese margen, y que el total nativo no cambió.
  const tasaLeida = numero(editada.currency_change);
  if (!Number.isFinite(tasaLeida) || Math.abs(tasaLeida - tasaNueva) > 0.0051 ||
      centimos(numero(editada.total)) !== centimos(total)) {
    throw new Error("Holded aceptó el ajuste, pero la relectura no confirma la tasa ni el total esperados; revisa el gasto antes de repetir.");
  }
  return {
    estado: "ajustada",
    montoEur: cargo,
    tasaAnterior: Number.isFinite(tasaActual) ? tasaActual : 1,
    tasaNueva,
    monedaDocumento,
  };
}
