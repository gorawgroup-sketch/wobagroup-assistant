import { compraTienePagos } from "../holded/recuperarConciliacionCompra";
import { margenImporteAproximado, movimientoLibreParaConciliar } from "../holded/write";
import type { CompraHoldedCruda, MovimientoBancarioCandidato } from "../holded/write";

/**
 * Par «este gasto ↔ este cargo» decidido por el OPERADOR (caso Nuria/MIMO, 2026-10-05): el gasto de Air France (152,00 EUR,
 * un ticket) y el cargo «Transavia» −176,12 USD (equivalente contable −151,95 €, 3 días antes). Ninguna búsqueda automática
 * puede emparejarlos (nombre distinto, otra moneda, fecha distinta) y la herramienta de conciliar solo localizaba el gasto en
 * el listado /purchases, que NO incluye tickets. Aquí se valida el par y se construye el candidato que luego ejecuta el flujo
 * de botones de siempre («🔗 Conciliar con #1»: alinea la moneda, concilia y aprende el par). No escribe nada.
 */
export type ResultadoParElegido =
  | { estado: "ok"; candidato: MovimientoBancarioCandidato }
  | { estado: "rechazado"; motivo: string };

export interface MovimientoBancarioLeido {
  id: string;
  description?: string;
  amount?: string | number;
  currency?: string;
  accounting_amount?: string | number | null;
  accounting_currency?: string;
  booking_date?: string;
  status?: string;
  reconciled_amount?: string;
}

export const numeroHolded = (valor: unknown): number => {
  if (typeof valor === "number") return valor;
  if (valor == null || String(valor).trim() === "") return NaN;
  const texto = String(valor).trim();
  return Number(texto.includes(",") ? texto.replace(/\./g, "").replace(",", ".") : texto);
};

export interface OpcionesParElegido {
  /**
   * El operador declara que el cargo incluye algo más que el gasto (una comisión de transferencia): se concilia solo la parte del gasto, el gasto
   * conserva su importe y el resto del cargo queda abierto (cargoMayor.ts). Solo con gasto y cargo en la MISMA moneda; sin esta declaración un
   * importe distinto sigue siendo una coincidencia «aproximada», que ajusta el gasto al cargo.
   */
  cargoMayor?: boolean;
}

export function evaluarParElegido(
  compra: Pick<CompraHoldedCruda, "total" | "currency" | "payments_total" | "payments_detail">,
  movimiento: MovimientoBancarioLeido,
  cuentaId: string,
  opciones: OpcionesParElegido = {}
): ResultadoParElegido {
  const rechazo = (motivo: string): ResultadoParElegido => ({ estado: "rechazado", motivo });
  if (compraTienePagos(compra as CompraHoldedCruda)) {
    return rechazo("el gasto ya tiene pagos o conciliaciones; no se le añade otro cargo sin revisarlo antes en Holded.");
  }
  if (!movimientoLibreParaConciliar(movimiento)) {
    return rechazo(`el cargo no está libre (estado «${movimiento.status ?? "?"}», conciliado ${movimiento.reconciled_amount ?? "?"}).`);
  }
  const nativo = numeroHolded(movimiento.amount);
  if (!Number.isFinite(nativo) || nativo >= 0) return rechazo("el movimiento no es un cargo de salida (importe negativo).");
  const total = numeroHolded(compra.total);
  if (!Number.isFinite(total) || total <= 0) return rechazo("no se pudo leer el total del gasto.");

  const monedaDoc = (compra.currency || "EUR").toUpperCase().trim();
  const monedaMov = (movimiento.currency || "EUR").toUpperCase().trim();
  const contable = numeroHolded(movimiento.accounting_amount);
  const fecha = (movimiento.booking_date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return rechazo("el movimiento no trae fecha válida.");
  const base = {
    accountId: cuentaId,
    movementId: movimiento.id,
    descripcion: movimiento.description ?? "",
    fecha,
    // Elegido a mano con nombre/fecha/moneda distintos: se muestra con el aviso de «confírmalo en Holded».
    origenCoincidencia: "aproximada" as const,
  };

  if (opciones.cargoMayor) {
    if (monedaDoc !== monedaMov) return rechazo(`el cargo mayor solo se admite con gasto y cargo en la misma moneda (gasto en ${monedaDoc}, cargo en ${monedaMov}).`);
    if (Math.abs(nativo) - total <= 0.005) return rechazo("el cargo no es mayor que el gasto: concilia el par normal, sin declarar cargo mayor.");
    return { estado: "ok", candidato: { ...base, monto: nativo, moneda: monedaDoc, origenCoincidencia: "cargo_mayor", restoDisponible: Math.abs(nativo) } };
  }
  if (monedaDoc === monedaMov) {
    return { estado: "ok", candidato: { ...base, monto: nativo, moneda: monedaDoc } };
  }
  if (monedaDoc === "EUR") {
    // Comprobante en EUR pagado desde una cuenta en otra moneda: se concilia por el equivalente contable en EUR y el flujo
    // alinea el gasto a la moneda real del cargo (alinearDocumentoAlCargoEnOtraMoneda).
    if (!Number.isFinite(contable) || contable >= 0) return rechazo("el cargo no trae equivalente contable en EUR.");
    if (Math.abs(Math.abs(contable) - total) > margenImporteAproximado(total)) {
      return rechazo(`el equivalente contable del cargo (${Math.abs(contable).toFixed(2)} EUR) difiere del gasto (${total.toFixed(2)} EUR) más del margen: ajusta primero el importe del gasto.`);
    }
    return { estado: "ok", candidato: { ...base, monto: contable, moneda: "EUR", montoNativo: nativo, monedaNativa: monedaMov } };
  }
  if (monedaMov === "EUR") {
    // Comprobante en otra moneda pagado desde una cuenta EUR: lo resuelve el ajuste de tasa del flujo habitual (tipo_cambio).
    return { estado: "ok", candidato: { ...base, monto: nativo, moneda: "EUR", origenCoincidencia: "tipo_cambio" } };
  }
  return rechazo(`gasto en ${monedaDoc} y cargo en ${monedaMov}: no se concilian directamente (ninguna es EUR); revísalo en Holded.`);
}
