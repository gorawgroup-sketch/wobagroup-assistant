import { listBankMovements, listTreasuryAccounts, estaConciliado, type Empresa } from "../client";

/**
 * Recibos cobrados en VARIOS pagos (p. ej. Uber: 8,95 USD = 6,91 + 2,04 con la misma tarjeta el mismo día). FASE 1 — OBSERVACIÓN:
 * lee los pagos del recibo, busca cada uno como su propio movimiento del banco y lo muestra como evidencia; NO concilia nada.
 * Además aplica una guardia general: un movimiento anterior al gasto no se propone nunca como coincidencia.
 */
export interface PagoRecibo { monto: number; fecha?: string }
export interface MovimientoBanco { accountId: string; cuenta: string; movementId: string; fecha: string; monto: number; moneda: string; descripcion: string }
export interface ParejaPago { pago: PagoRecibo; movimiento: MovimientoBanco }
export interface ResultadoEmparejado { pares: ParejaPago[]; sinPareja: PagoRecibo[] }

const DIA = 86_400_000;
const dias = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DIA);

/** Convierte lo que devuelve el lector del recibo en pagos válidos (importes positivos, fecha ISO opcional, máx. 10). */
export function normalizarPagos(raw: unknown): PagoRecibo[] {
  if (!Array.isArray(raw)) return [];
  const salida: PagoRecibo[] = [];
  for (const p of raw.slice(0, 10)) {
    const monto = Number((p as { monto?: unknown })?.monto);
    const fecha = String((p as { fecha?: unknown })?.fecha ?? "");
    if (Number.isFinite(monto) && monto > 0) salida.push({ monto: Math.round(monto * 100) / 100, fecha: /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : undefined });
  }
  return salida;
}

/** Los pagos son un desglose válido solo si suman el total del recibo (a la décima de céntimo de redondeo). */
export function pagosCuadran(pagos: readonly PagoRecibo[], total: number, tolerancia = 0.011): boolean {
  return pagos.length >= 2 && Math.abs(pagos.reduce((s, p) => s + p.monto, 0) - total) <= tolerancia;
}

/** Un movimiento fechado antes del gasto (con 1 día de holgura por husos horarios) no puede ser su cargo. */
export const esAnteriorAlGasto = (fechaMovimiento: string, fechaGasto: string, holguraDias = 1): boolean =>
  /^\d{4}-\d{2}-\d{2}/.test(fechaMovimiento) && /^\d{4}-\d{2}-\d{2}/.test(fechaGasto) && dias(fechaMovimiento.slice(0, 10), fechaGasto.slice(0, 10)) < -holguraDias;

/** Cada pago busca SU movimiento: mismo importe exacto, misma moneda (la de los candidatos), fecha cercana; cada movimiento se usa una sola vez. */
export function emparejarPagos(pagos: readonly PagoRecibo[], movimientos: readonly MovimientoBanco[], fechaGasto: string, margenDias = 2): ResultadoEmparejado {
  const usados = new Set<string>();
  const pares: ParejaPago[] = [];
  const sinPareja: PagoRecibo[] = [];
  for (const pago of [...pagos].sort((a, b) => b.monto - a.monto)) {
    const objetivo = pago.fecha ?? fechaGasto;
    const candidatos = movimientos
      .filter((m) => !usados.has(m.movementId) && Math.abs(m.monto - pago.monto) <= 0.005 && !esAnteriorAlGasto(m.fecha, fechaGasto) && Math.abs(dias(m.fecha.slice(0, 10), objetivo)) <= margenDias)
      .sort((a, b) => Math.abs(dias(a.fecha.slice(0, 10), objetivo)) - Math.abs(dias(b.fecha.slice(0, 10), objetivo)));
    if (candidatos.length === 0) { sinPareja.push(pago); continue; }
    usados.add(candidatos[0].movementId);
    pares.push({ pago, movimiento: candidatos[0] });
  }
  return { pares, sinPareja };
}

/** Movimientos del banco SIN conciliar y de salida, en la moneda del recibo, alrededor de la fecha del gasto. Solo lectura. */
export async function leerMovimientosCandidatos(empresa: Empresa, moneda: string, fechaGasto: string): Promise<MovimientoBanco[]> {
  const desde = new Date(Date.parse(`${fechaGasto}T00:00:00Z`) - 4 * DIA).toISOString().slice(0, 10);
  const hasta = new Date(Date.parse(`${fechaGasto}T00:00:00Z`) + 5 * DIA).toISOString().slice(0, 10);
  const salida: MovimientoBanco[] = [];
  for (const cuenta of await listTreasuryAccounts(empresa)) {
    if (cuenta.archived === true || String(cuenta.currency ?? "").toUpperCase() !== moneda.toUpperCase()) continue;
    for (const m of await listBankMovements(empresa, cuenta.id, desde, hasta)) {
      const monto = Number(m.amount);
      if (!m.id || !Number.isFinite(monto) || monto >= 0 || estaConciliado(m.status)) continue;
      salida.push({ accountId: cuenta.id, cuenta: cuenta.name ?? cuenta.id, movementId: m.id, fecha: String(m.booking_date ?? "").slice(0, 10), monto: Math.abs(monto), moneda: moneda.toUpperCase(), descripcion: m.description ?? "" });
    }
  }
  return salida;
}

export interface EvaluacionPagos {
  /** true → la coincidencia aproximada actual no debe proponerse (es anterior al gasto, o el recibo tiene varios pagos). */
  descartarAproximado: boolean;
  /** Texto para el mensaje de la propuesta (vacío si no aplica). */
  nota: string;
}

const f2 = (n: number) => n.toFixed(2);

export async function evaluarPagosMultiples(
  entrada: { empresa: Empresa; moneda: string; total: number; fechaGasto: string; pagos?: readonly PagoRecibo[]; aproximada?: { fecha: string; monto: number; descripcion?: string } },
  leer: (empresa: Empresa, moneda: string, fecha: string) => Promise<MovimientoBanco[]> = leerMovimientosCandidatos,
): Promise<EvaluacionPagos> {
  const { aproximada, pagos = [] } = entrada;
  const anterior = aproximada ? esAnteriorAlGasto(aproximada.fecha, entrada.fechaGasto) : false;
  const notaAnterior = anterior && aproximada
    ? `\n\n🚫 Descarté un movimiento parecido ("${aproximada.descripcion || "sin descripción"}", ${f2(aproximada.monto)} ${entrada.moneda}, ${aproximada.fecha}) porque es ANTERIOR al gasto (${entrada.fechaGasto}): no puede ser su cargo.`
    : "";
  if (!pagosCuadran(pagos, entrada.total)) return { descartarAproximado: anterior, nota: notaAnterior };

  const suma = pagos.map((p) => f2(p.monto)).join(" + ");
  const encabezado = `\n\n🧾 El recibo se cobró en ${pagos.length} pagos (${suma} = ${f2(entrada.total)} ${entrada.moneda}).`;
  let emparejado: ResultadoEmparejado;
  try { emparejado = emparejarPagos(pagos, await leer(entrada.empresa, entrada.moneda, entrada.fechaGasto), entrada.fechaGasto); }
  catch { return { descartarAproximado: true, nota: `${encabezado} No pude consultar el banco ahora; no propongo conciliar con una coincidencia aproximada.${notaAnterior}` }; }
  const lineas = emparejado.pares.map((p, i) => `  ${i + 1}. "${p.movimiento.descripcion || "(sin descripción)"}" — ${f2(p.movimiento.monto)} ${p.movimiento.moneda} (${p.movimiento.fecha}) · ${p.movimiento.cuenta}`);
  if (emparejado.sinPareja.length === 0) {
    return { descartarAproximado: true, nota: `${encabezado} Encontré en el banco los ${pagos.length} cargos, cada uno con su importe exacto:\n${lineas.join("\n")}\nSon estos los que corresponden a este gasto. Conciliar un gasto con varios movimientos aún no está activado: por ahora el gasto se crea sin conciliar y estos cargos quedan para conciliarse con tu confirmación.${notaAnterior}` };
  }
  const faltan = emparejado.sinPareja.map((p) => `${f2(p.monto)} ${entrada.moneda}`).join(", ");
  return { descartarAproximado: true, nota: `${encabezado} ${emparejado.pares.length > 0 ? `Encontré ${emparejado.pares.length} cargo(s):\n${lineas.join("\n")}\n` : ""}No encontré en el banco el/los pago(s) de ${faltan}. Puede que el banco aún no los refleje: no propongo ninguna coincidencia aproximada.${notaAnterior}` };
}
