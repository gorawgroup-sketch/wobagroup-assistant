import { createHash } from "node:crypto";
import type { Empresa } from "../holded/client";
import {
  editarCompraHolded,
  leerEstadoMovimiento,
  margenResiduoConversion,
  movimientoLibreParaConciliar,
  obtenerCompraHoldedPorId,
  validarCompraContraMovimiento,
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

/**
 * Cargo MAYOR que el gasto en la misma moneda extranjera (gasto de 1.750 USD pagado con una transferencia de 1.778,98 USD que incluye 28,98 de
 * comisión). El gasto conserva su importe, así que NO se edita su tasa (editar la compra duplica su adjunto en Holded): se concilia su parte y el
 * resto del cargo queda abierto. Holded paga en EUR; la parte del gasto valdrá, a la tasa del banco, `contable × gasto ÷ cargo` EUR, y esa cifra solo
 * puede diferir del valor del gasto a su propia tasa por el redondeo que ya cierra el ajuste de cambio. Si la diferencia pasa del margen de
 * redondeo, no se concilia nada: igualarla exigiría editar la tasa del gasto, decisión de una persona sobre ese gasto.
 */
function evaluarCargoMayorMismaMoneda(
  compra: { currency_change?: unknown; payments_total?: unknown; payments_detail?: unknown },
  importeMovimiento: number,
  contable: number,
  total: number,
  moneda: string
): ResultadoAlineacionTasa {
  const cargo = Math.abs(importeMovimiento);
  const tasa = numero(compra.currency_change);
  if (!Number.isFinite(cargo) || !Number.isFinite(total) || !Number.isFinite(tasa) || tasa <= 0 || total <= 0 || importeMovimiento >= 0) {
    throw new Error("Importes no válidos para conciliar un cargo mayor.");
  }
  if (cargo - total <= 0.005) throw new Error("El cargo elegido no es mayor que el gasto; no se concilia como cargo mayor.");
  if (compraTienePagos(compra as never)) throw new Error("El gasto ya tiene pagos; no se concilia otro cargo mayor automáticamente.");
  const parteEur = (Math.abs(contable) * total) / cargo;
  const valorGastoEur = total / tasa;
  const diferencia = Math.abs(parteEur - valorGastoEur) * tasa; // en la moneda del gasto
  const margen = margenResiduoConversion(total);
  if (diferencia > margen) {
    throw new Error(
      `La parte del gasto a la tasa del banco (${parteEur.toFixed(2)} EUR) difiere de su valor al cambio del gasto (${valorGastoEur.toFixed(2)} EUR) en ` +
      `${diferencia.toFixed(2)} ${moneda}, más que el margen de redondeo (${margen.toFixed(2)} ${moneda}). Igualarla exigiría editar la tasa del gasto ` +
      `(Holded duplica su adjunto al editar) y eso no se hace dentro de una conciliación de cargo mayor. No se concilió nada.`
    );
  }
  return {
    estado: "no_aplica",
    motivo: `cargo mayor: la parte del gasto (${parteEur.toFixed(2)} EUR a la tasa del banco) difiere ${diferencia.toFixed(2)} ${moneda} de su valor al cambio del gasto; ` +
      "es redondeo y lo cierra el ajuste de cambio, sin editar el gasto",
  };
}

export type ResultadoAlineacionTasa =
  | { estado: "no_aplica"; motivo: string }
  | { estado: "ya_alineada"; montoEur: number; tasa: number }
  | { estado: "ajustada"; montoEur: number; tasaAnterior: number; tasaNueva: number; monedaDocumento: string };

const depsDefault = {
  leerCompra: obtenerCompraHoldedPorId,
  leerMovimiento: leerEstadoMovimiento,
  editar: editarCompraHolded,
  /** Misma comprobación de solo lectura que hará la conciliación: si va a rechazarla, no se toca la tasa. */
  validar: (empresa: Empresa, gastoId: string, elegido: MovimientoBancarioCandidato) =>
    validarCompraContraMovimiento(empresa, gastoId, elegido.accountId, elegido.movementId, elegido.fecha, true),
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
  const importeMovimiento = numero(movimiento?.amount);
  const total = numero(compra.total);
  // Equivalente en EUR del cargo: su importe si la cuenta es EUR; si gasto y cargo están en la MISMA moneda extranjera (recibo en USD
  // pagado desde la cuenta en USD), el equivalente contable que Holded da al cargo. Caso real 14-10-2026 (Airbnb 495,13 y 309,74 USD):
  // el pago quedó anotado por el equivalente del cargo (428,04 €) pero la compra llevaba otra tasa y Holded la dejó «parcial».
  let cargo: number;
  if (monedaMovimiento === "EUR") {
    cargo = Math.abs(importeMovimiento);
  } else if (monedaDocumento === monedaMovimiento) {
    const contable = numero(movimiento?.accounting_amount);
    if (!Number.isFinite(contable) || contable === 0) {
      return { estado: "no_aplica", motivo: `Holded no informa el equivalente contable en EUR del cargo en ${monedaMovimiento}` };
    }
    if (elegido.origenCoincidencia === "cargo_mayor") return evaluarCargoMayorMismaMoneda(compra, importeMovimiento, contable, total, monedaDocumento);
    if (Math.abs(Math.abs(importeMovimiento) - Math.abs(elegido.monto)) > 0.005 || Math.abs(Math.abs(importeMovimiento) - total) > 0.005) {
      throw new Error("El cargo en la moneda del gasto no coincide con su importe; no se ajustó la tasa de cambio del gasto.");
    }
    cargo = Math.abs(contable);
  } else {
    return { estado: "no_aplica", motivo: `el cargo está en ${monedaMovimiento}: no se conoce su equivalente exacto en EUR` };
  }
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(cargo) || cargo <= 0 || importeMovimiento >= 0) {
    throw new Error("Importes no válidos para ajustar la tasa de cambio del gasto.");
  }
  if (monedaMovimiento === "EUR" && Math.abs(cargo - Math.abs(elegido.monto)) > 0.005) {
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

  // Con 6 decimales de tasa el equivalente en EUR debe reproducir el cargo al céntimo (no ocurre con importes muy
  // grandes en monedas de tasa cercana a 1). Si no, ajustar dejaría un residuo: se concilia como antes y se avisa.
  if (centimos(total / tasaNueva) !== centimos(cargo)) {
    return { estado: "no_aplica", motivo: "con la precisión de tasa que admite Holded este importe no queda exacto al céntimo" };
  }

  // Si la conciliación va a rechazarse de forma determinista (pagos, moneda de la cuenta…), no se modifica la tasa.
  await deps.validar(empresa, gastoId, elegido);

  // La clave incluye el estado previo del gasto: un reintento tras editar la fecha o el número no choca con la huella
  // guardada de un ajuste anterior.
  const estadoPrevio = createHash("sha256")
    .update(`${compra.currency_change ?? ""}|${compra.date ?? ""}|${compra.document_number ?? ""}`)
    .digest("hex")
    .slice(0, 12);
  const editada = await deps.editar(empresa, gastoId, { tasaCambioNueva: tasaNueva }, {
    idempotencyKey: `ajuste-tasa-movimiento:${gastoId}:${elegido.movementId}:${Math.round(tasaNueva * 1e6)}:${estadoPrevio}`,
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
