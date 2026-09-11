import { textosParecidos } from "../utils/textoParecido";

export interface MovimientoHoldedParaDuplicado {
  id?: string;
  description?: string;
  amount?: string | number;
  currency?: string;
  accounting_amount?: string | number | null;
  booking_date?: string;
  status?: string;
  reconciled_amount?: string | number | null;
}

export interface CoincidenciaMovimientoConciliado {
  nivel: "exacta" | "probable";
  monto: number;
  moneda: string;
  fecha: string;
  coincideProveedor: boolean;
  coincideFechaExacta: boolean;
  diferenciaMonto: number;
}

function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function proveedorPareceEnDescripcion(proveedor: string, descripcion: string): boolean {
  const p = normalizarTexto(proveedor);
  const d = normalizarTexto(descripcion);
  if (p.length < 3 || d.length < 3) return false;
  return d.includes(p) || p.includes(d) || textosParecidos(proveedor, descripcion);
}

function parsearDecimal(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function fechaCalendario(raw: string | undefined): string {
  return raw?.slice(0, 10) ?? "";
}

/**
 * Señal conservadora para impedir que un ticket ya conciliado se vuelva a
 * registrar como factura. Holded deja de devolver algunos documentos por
 * /purchases cuando en la interfaz se desmarca "Es una factura de compra",
 * pero el movimiento bancario conciliado continúa visible.
 */
export function evaluarMovimientoConciliadoComoDuplicado(
  movimiento: MovimientoHoldedParaDuplicado,
  criterios: { proveedor: string; monto: number; fecha: string; moneda?: string }
): CoincidenciaMovimientoConciliado | undefined {
  if (!new Set(["reconciled", "forced_reconciled", "partial"]).has(movimiento.status ?? "")) return undefined;

  const monedaObjetivo = (criterios.moneda ?? "EUR").toUpperCase().trim();
  const monedaNativa = (movimiento.currency ?? "EUR").toUpperCase().trim();
  let monto: number;
  if (monedaObjetivo === "EUR") {
    monto = monedaNativa !== "EUR" && movimiento.accounting_amount != null
      ? parsearDecimal(movimiento.accounting_amount)
      : parsearDecimal(movimiento.amount);
  } else {
    if (monedaNativa !== monedaObjetivo) return undefined;
    monto = parsearDecimal(movimiento.amount);
  }
  if (!Number.isFinite(monto)) return undefined;

  const diferenciaMonto = Math.abs(Math.abs(monto) - Math.abs(criterios.monto));
  const montoExacto = diferenciaMonto <= 0.011;
  const montoCercano = diferenciaMonto <= Math.max(0.5, Math.abs(criterios.monto) * 0.01);
  const coincideProveedor = proveedorPareceEnDescripcion(criterios.proveedor, movimiento.description ?? "");
  const coincideFechaExacta = fechaCalendario(movimiento.booking_date) === criterios.fecha.slice(0, 10);

  // Una coincidencia por monto exacto exige además nombre o fecha. Una
  // aproximada exige ambas señales para evitar bloquear gastos recurrentes
  // legítimos por una cantidad parecida.
  if (!(montoExacto && (coincideProveedor || coincideFechaExacta)) && !(montoCercano && coincideProveedor && coincideFechaExacta)) {
    return undefined;
  }

  return {
    nivel: montoExacto && coincideProveedor && coincideFechaExacta ? "exacta" : "probable",
    monto,
    moneda: monedaObjetivo,
    fecha: fechaCalendario(movimiento.booking_date),
    coincideProveedor,
    coincideFechaExacta,
    diferenciaMonto,
  };
}
