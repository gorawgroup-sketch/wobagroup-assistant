/**
 * Cargo bancario MAYOR que el gasto (caso real Go Rent A Car, Footprint, 2026-10-01): el comprobante era de
 * 354,62 USD y el banco descontó 744,87 USD en un solo cargo del mismo proveedor. Ni la búsqueda exacta ni la
 * aproximada lo ven (la diferencia es enorme), y la propuesta decía «no encontré ningún movimiento».
 *
 * Regla pedida por el propietario: avisar de ese cargo y dejar ELEGIR conciliar el gasto contra él; el cargo queda
 * parcialmente conciliado a la espera del gasto que cubra el resto. Si no llega otro gasto, se pregunta al originador
 * del correo por la diferencia. Nunca se elige ni se concilia solo: siempre es una opción «Conciliar con #N».
 *
 * Aquí vive solo la decisión pura (qué cargo cuenta como «mayor») y su texto; la lectura de Holded está en write.ts.
 */

/** Días hacia atrás y hacia delante de la fecha del comprobante en los que se busca el cargo mayor. */
export const DIAS_ATRAS_CARGO_MAYOR = 10;
export const DIAS_ADELANTE_CARGO_MAYOR = 5;
/** Tope de cargos «a la espera de su resto» que se enseñan a la vez (los más cercanos en fecha). */
export const MAX_CANDIDATOS_CARGO_MAYOR = 3;

const CENTIMO = 0.01;

function numero(valor: string | number | null | undefined): number {
  if (typeof valor === "number") return valor;
  if (valor === null || valor === undefined || valor === "") return NaN;
  return Number(String(valor).replace(",", "."));
}

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100;
}

export interface MovimientoParaCargoMayor {
  amount?: string | number;
  reconciled_amount?: string | number | null;
}

/** Lo que todavía no se ha asignado de un cargo (importe total menos lo ya conciliado). */
export function restoLibreMovimiento(movimiento: MovimientoParaCargoMayor): number {
  const total = Math.abs(numero(movimiento.amount));
  const enlazado = Math.abs(numero(movimiento.reconciled_amount) || 0);
  if (!Number.isFinite(total)) return NaN;
  return redondear(total - enlazado);
}

/**
 * ¿Este cargo puede cubrir el gasto dejando (o habiendo dejado) una parte para otro documento?
 * - Tiene que ser un cargo (importe negativo): un ingreso o una devolución no paga un gasto.
 * - Le tiene que quedar libre al menos el importe del gasto.
 * - Si está intacto y su importe es casi el del gasto, no es «mayor»: eso ya lo resuelven la búsqueda exacta y la
 *   aproximada (`margenAproximado` es la banda de esta última).
 * Un cargo ya usado en parte cuenta aunque su resto sea justo el del gasto: es el segundo gasto del mismo cargo.
 */
export function evaluarCargoMayor(
  movimiento: MovimientoParaCargoMayor,
  montoGasto: number,
  margenAproximado: number
): { resto: number; restoTrasConciliar: number } | undefined {
  const importe = numero(movimiento.amount);
  const gasto = Math.abs(montoGasto);
  if (!Number.isFinite(importe) || !(importe < 0) || !Number.isFinite(gasto) || gasto <= 0) return undefined;
  const resto = restoLibreMovimiento(movimiento);
  if (!Number.isFinite(resto) || resto + CENTIMO < gasto) return undefined;
  const enlazado = Math.abs(numero(movimiento.reconciled_amount) || 0);
  if (enlazado <= CENTIMO && Math.abs(importe) - gasto <= margenAproximado) return undefined;
  return { resto, restoTrasConciliar: Math.max(0, redondear(resto - gasto)) };
}

/**
 * Qué cargos mayores merece la pena enseñar. Comprobado contra el banco real (Footprint, 2026-10-01): un Uber de 4,48 €
 * sin cargo todavía tenía tres cargos de Uber mayores esa misma semana, todos de otros viajes; ofrecerlos solo invitaría
 * a una conciliación parcial equivocada. Por eso:
 * - si algún cargo ya está conciliado en parte, es uno que espera su resto: se ofrecen esos;
 * - si no, solo se ofrece cuando hay UN único cargo mayor (caso Go Rent A Car); varios no dicen nada.
 */
export function elegirCargosMayores<T extends { monto: number; restoDisponible?: number }>(candidatos: T[]): T[] {
  const esperandoResto = candidatos.filter((c) => c.restoDisponible !== undefined && Math.abs(c.monto) - c.restoDisponible > CENTIMO);
  if (esperandoResto.length > 0) return esperandoResto.slice(0, MAX_CANDIDATOS_CARGO_MAYOR);
  return candidatos.length === 1 ? candidatos : [];
}

export interface CargoMayorDescrito {
  descripcion: string;
  monto: number;
  moneda: string;
  fecha: string;
  restoDisponible?: number;
}

/** Línea numerada para la propuesta: qué cargo es, cuánto le queda libre y cuánto quedaría pendiente de otro gasto. */
export function describirCargoMayor(m: CargoMayorDescrito, montoGasto: number, indice: number): string {
  const total = Math.abs(m.monto);
  const resto = m.restoDisponible ?? total;
  const quedaria = Math.max(0, redondear(resto - Math.abs(montoGasto)));
  const yaUsado = redondear(total - resto);
  const usado = yaUsado > CENTIMO ? `, ya tiene ${yaUsado.toFixed(2)} ${m.moneda} conciliados con otro gasto` : "";
  const despues = quedaria > CENTIMO
    ? `quedarían ${quedaria.toFixed(2)} ${m.moneda} del cargo a la espera de otro gasto`
    : "el cargo quedaría conciliado por completo";
  return `  ${indice + 1}. "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} ${m.moneda} (${m.fecha})${usado}; ` +
    `si lo concilias con este gasto, ${despues}.`;
}

/** Bloque completo para la propuesta de gasto cuando solo se encontraron cargos mayores del mismo proveedor. */
export function notaCargosMayores(
  cargos: CargoMayorDescrito[],
  gasto: { monto: number; moneda: string; proveedor: string },
  opciones: { hayCorreoOrigen: boolean }
): string {
  if (cargos.length === 0) return "";
  const uno = cargos.length === 1;
  return `\n\n💳 No hay un cargo por ${Math.abs(gasto.monto).toFixed(2)} ${gasto.moneda}, pero el banco sí tiene ` +
    `${uno ? "un cargo MAYOR" : `${cargos.length} cargos MAYORES`} de "${gasto.proveedor}" en esas fechas:\n` +
    cargos.map((c, i) => describirCargoMayor(c, gasto.monto, i)).join("\n") +
    `\nSi este gasto es una parte de ese cargo, marca "🔗 Conciliar con #N" y aprueba: el gasto se crea por su importe real ` +
    `(no se cambia) y el cargo queda parcialmente conciliado hasta que llegue el gasto del resto. ` +
    (opciones.hayCorreoOrigen
      ? `Si no esperas otro gasto de ese cargo, marca también "✉️ Responder correo" para preguntar a quien lo envió por la diferencia. `
      : `Si no esperas otro gasto de ese cargo, pregunta a quien hizo el gasto por la diferencia. `) +
    `Wobi no lo elige ni lo concilia por su cuenta.`;
}

/** Frase para el borrador de respuesta al originador: el banco cobró más de lo que dice el comprobante. */
export function contextoCorreoCargoMayor(cargo: CargoMayorDescrito, montoGasto: number): string {
  const resto = cargo.restoDisponible ?? Math.abs(cargo.monto);
  const diferencia = Math.max(0, redondear(resto - Math.abs(montoGasto)));
  return ` El banco registra un cargo de ${Math.abs(cargo.monto).toFixed(2)} ${cargo.moneda} del ${cargo.fecha} ` +
    `("${cargo.descripcion || "sin descripción"}"), mayor que este comprobante: quedan ${diferencia.toFixed(2)} ${cargo.moneda} ` +
    `sin justificar. Pregunta a qué corresponde esa diferencia y pide el comprobante que falta.`;
}
