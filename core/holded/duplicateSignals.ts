import { textosParecidos } from "../utils/textoParecido";

export interface MovimientoHoldedParaDuplicado {
  id?: string;
  description?: string;
  amount?: string | number;
  currency?: string;
  accounting_amount?: string | number | null;
  booking_date?: string;
  status?: string;
  origin?: string;
  reconciled_amount?: string | number | null;
}

export interface CoincidenciaMovimientoConciliado {
  nivel: "exacta" | "probable";
  monto: number;
  moneda: string;
  fecha: string;
  coincideProveedor: boolean;
  coincideFechaExacta: boolean;
  /** Diferencia en días naturales entre el comprobante y el cargo bancario. */
  diferenciaDias: number;
  /** true cuando el comprobante no trae proveedor y se usó evidencia bancaria reforzada. */
  sinProveedorIdentificado: boolean;
  diferenciaMonto: number;
}

// Un ticket puede emitirse o reenviarse unos días después de que la tarjeta
// registre el cargo. Si además no muestra razón social, no existe señal de
// proveedor con la que comparar. En ese caso solo aceptamos evidencia mucho
// más estricta: importe exacto, conciliación completa y fecha muy cercana.
const VENTANA_DIAS_SIN_PROVEEDOR = 3;

// Hallazgo real de auditoría (caso Holded Technologies, 123.42€/mes en
// Footprint): la rama de "importe exacto + coincide proveedor" no exigía
// ninguna cercanía de fecha, así que un cargo mensual recurrente con importe
// fijo quedaba marcado como "probable duplicado" del cargo YA conciliado del
// mes anterior (y el anterior a ese, sin límite) para siempre — bloqueando
// cada mes nuevo del mismo gasto legítimo. Esta ventana acota esa rama a un
// desfase plausible entre ticket y cargo bancario (igual criterio que
// VENTANA_DIAS_BUSQUEDA en write.ts para "compras similares"), sin debilitar
// la detección real: dos cargos separados por más de esto ya no son
// candidatos razonables a ser la misma transacción.
const VENTANA_DIAS_COINCIDENCIA_MOVIMIENTO = 15;

function diferenciaDiasCalendario(a: string | undefined, b: string): number {
  const fechaA = fechaCalendario(a);
  const fechaB = fechaCalendario(b);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaA) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaB)) return Number.POSITIVE_INFINITY;
  const [anoA, mesA, diaA] = fechaA.split("-").map(Number);
  const [anoB, mesB, diaB] = fechaB.split("-").map(Number);
  return Math.abs(Date.UTC(anoA, mesA - 1, diaA) - Date.UTC(anoB, mesB - 1, diaB)) / 86_400_000;
}

function conciliacionCompleta(movimiento: MovimientoHoldedParaDuplicado): boolean {
  if (!new Set(["reconciled", "forced_reconciled"]).has(movimiento.status ?? "")) return false;
  const monto = parsearDecimal(movimiento.amount);
  const conciliado = parsearDecimal(movimiento.reconciled_amount);
  return Number.isFinite(monto) && Number.isFinite(conciliado) && Math.abs(Math.abs(monto) - Math.abs(conciliado)) <= 0.011;
}

function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * La extracción documental no siempre deja el proveedor vacío cuando no
 * puede leerlo. A veces devuelve una etiqueta descriptiva para que el
 * usuario entienda el problema (por ejemplo, "Establecimiento no
 * identificado (cafetería)"). Esa etiqueta NO es un proveedor real y no
 * puede usarse para exigir que el extracto bancario contenga el mismo
 * nombre. Mantener esta lista cerrada evita tratar como desconocido a un
 * comercio real que simplemente tenga un nombre poco habitual.
 */
export function esProveedorNoIdentificado(proveedor: string | undefined): boolean {
  const normalizado = normalizarTexto(proveedor ?? "");
  if (!normalizado) return true;
  return [
    /^establecimiento no identificado(?:\b|$)/,
    /^proveedor no identificado(?:\b|$)/,
    /^proveedor desconocido(?:\b|$)/,
    /^sin proveedor(?:\b|$)/,
    /^unknown (?:merchant|vendor|supplier)(?:\b|$)/,
    /^unidentified (?:merchant|vendor|supplier)(?:\b|$)/,
    // El modelo también puede anteponer una categoría (caso real: "Aerolínea no identificada en el
    // documento"). Sigue siendo una descripción de ausencia, no la identidad legal/comercial de un
    // proveedor. Se exige la frase completa para no confundir empresas reales que contengan una sola
    // de estas palabras fuera de este patrón.
    /\bno identificad[oa](?:\b|$)/,
    /\b(?:proveedor|comercio|empresa|aerolinea) desconocid[oa](?:\b|$)/,
  ].some((patron) => patron.test(normalizado));
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
  // Hallazgo real de auditoría (Footprint, cuenta USD, 2026-09-08): dos viajes de Uber distintos el
  // mismo día ("Uber Pending", 3.55 y 3.77 USD) — el piso fijo de 0.50 hacía que CUALQUIER cargo del
  // mismo proveedor ese día calificara como "monto cercano" (diferencia real: 0.22, muy por debajo
  // del piso), bloqueando la creación de un gasto real y distinto solo por compartir proveedor y
  // fecha. Para importes chicos (la mayoría de tickets de transporte/comida) ese piso era mucho mayor
  // que la propia transacción. Se conserva el 1% proporcional para importes grandes (variación
  // plausible de tipo de cambio o cargos), pero el piso baja a un margen de céntimos, no de dólares.
  const montoCercano = diferenciaMonto <= Math.max(0.05, Math.abs(criterios.monto) * 0.01);
  const coincideProveedor = proveedorPareceEnDescripcion(criterios.proveedor, movimiento.description ?? "");
  const coincideFechaExacta = fechaCalendario(movimiento.booking_date) === criterios.fecha.slice(0, 10);
  const diferenciaDias = diferenciaDiasCalendario(movimiento.booking_date, criterios.fecha);
  const sinProveedorIdentificado = esProveedorNoIdentificado(criterios.proveedor);
  const coincidenciaReforzadaSinProveedor =
    sinProveedorIdentificado &&
    montoExacto &&
    diferenciaDias <= VENTANA_DIAS_SIN_PROVEEDOR &&
    conciliacionCompleta(movimiento);

  // Una coincidencia por monto exacto exige además nombre o fecha Y una
  // cercanía de fecha plausible (VENTANA_DIAS_COINCIDENCIA_MOVIMIENTO) — sin
  // este último requisito, un proveedor con cargos recurrentes de igual
  // importe (una suscripción mensual, por ejemplo) matchearía contra
  // cualquier mes anterior ya conciliado sin límite de tiempo. Una
  // aproximada exige ambas señales (proveedor Y fecha exacta) para evitar
  // bloquear gastos recurrentes legítimos por una cantidad parecida.
  // Excepción conservadora: si el ticket no trae proveedor, un cargo
  // completamente conciliado, exacto y a <=3 días se devuelve como
  // PROBABLE. El llamador muestra todos los candidatos y bloquea la
  // creación; nunca concilia ni decide en silencio.
  if (
    !(montoExacto && (coincideProveedor || coincideFechaExacta) && diferenciaDias <= VENTANA_DIAS_COINCIDENCIA_MOVIMIENTO) &&
    !(montoCercano && coincideProveedor && coincideFechaExacta) &&
    !coincidenciaReforzadaSinProveedor
  ) {
    return undefined;
  }

  return {
    nivel: montoExacto && coincideProveedor && coincideFechaExacta ? "exacta" : "probable",
    monto,
    moneda: monedaObjetivo,
    fecha: fechaCalendario(movimiento.booking_date),
    coincideProveedor,
    coincideFechaExacta,
    diferenciaDias,
    sinProveedorIdentificado,
    diferenciaMonto,
  };
}

/** Only a bank-origin, unused debit with exact amount/date/provider can
 * outrank a near-amount reconciled charge. Currency conversion is not inferred.
 */
export function esCargoLibreExactoParaDuplicado(
  m: MovimientoHoldedParaDuplicado,
  c: { proveedor: string; monto: number; fecha: string; moneda?: string }
): boolean {
  const monto = parsearDecimal(m.amount);
  return Boolean(m.id && m.origin && m.origin !== "manual") && m.status === "pending" &&
    parsearDecimal(m.reconciled_amount) === 0 && monto < 0 && Number.isFinite(c.monto) && c.monto > 0 &&
    Math.abs(-monto - c.monto) < 0.005 &&
    (m.currency ?? "").toUpperCase() === (c.moneda ?? "EUR").toUpperCase() &&
    fechaCalendario(m.booking_date) === c.fecha.slice(0,10) &&
    !esProveedorNoIdentificado(c.proveedor) && proveedorPareceEnDescripcion(c.proveedor, m.description ?? "");
}
export function priorizarCargoLibreExacto<T extends { nivel: "exacta" | "probable"; monto: number; moneda: string }>(
  conciliados: T[], libresExactos: Set<string>, monto: number, moneda = "EUR"
): T[] {
  if (libresExactos.size !== 1) return conciliados;
  // Exact occupied matches and all registered-purchase checks still block.
  return conciliados.filter(m => m.nivel === "exacta" || m.moneda.toUpperCase() !== moneda.toUpperCase() ||
    Math.abs(Math.abs(m.monto) - monto) <= 0.011);
}
