/**
 * Cuando el vigilante confirma un pago en el banco, el calendario lo refleja: la fila pasa a «pagado» (con el importe real) y, si es
 * de una serie (anual, semestral…), se genera el siguiente pago —con el mismo importe, marcado «estimado»— para que el calendario no se
 * quede sin futuro. Puro: devuelve qué hay que escribir; quien llama lo aplica.
 */
import { diasEntre } from "../vigilante/fechas";
import { formatearEuros } from "../vigilante/importes";
import { idPago } from "./semilla";
import type { PagoSeguro } from "./tipos";

/** Días de margen entre la fecha prevista y la del apunte del banco (un adeudo puede retrasarse o devolverse y volver a pasar). */
export const MARGEN_DIAS_CONFIRMACION = 12;
/** Una fila de la misma serie a menos de estos días de la fecha del siguiente pago cuenta como «ya existe». */
const MARGEN_DIAS_SERIE = 20;
const TOLERANCIA_IMPORTE = 0.15;

const moneda = (m: string): string => (m === "EUR" ? "€" : m);

export interface ConfirmacionDePago {
  polizaIds: string[];
  /** Fecha del apunte del banco (YYYY-MM-DD). */
  fecha: string;
  /** Importe pagado, positivo y en la moneda del pago. */
  importe: number;
  movimientoId: string;
  cuenta: string;
}

export interface CambiosPorConfirmacion {
  actualizaciones: Array<{ id: string; cambios: Partial<PagoSeguro> }>;
  nuevos: PagoSeguro[];
}

/** Suma meses a una fecha YYYY-MM-DD respetando el fin de mes (31/08 + 6 meses = 28/02). */
export function sumarMeses(fecha: string, meses: number): string {
  const [anio, mes, dia] = fecha.split("-").map(Number);
  const destino = new Date(Date.UTC(anio, mes - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0)).getUTCDate();
  destino.setUTCDate(Math.min(dia, ultimoDia));
  return destino.toISOString().slice(0, 10);
}

export function aplicarConfirmacionAPagos(pagos: PagoSeguro[], c: ConfirmacionDePago, hoy: string): CambiosPorConfirmacion {
  const resultado: CambiosPorConfirmacion = { actualizaciones: [], nuevos: [] };
  const unaSolaPoliza = c.polizaIds.length === 1;
  const yaTratados = new Set<string>();
  for (const polizaId of c.polizaIds) {
    const candidatos = pagos
      .filter((p) => p.polizaId === polizaId && p.estado === "previsto" && !yaTratados.has(p.id) && Math.abs(diasEntre(p.fecha, c.fecha)) <= MARGEN_DIAS_CONFIRMACION)
      // Con un solo recibo el importe también tiene que cuadrar; una transferencia que paga varios recibos solo trae el total.
      .filter((p) => !unaSolaPoliza || Math.abs(p.importe - c.importe) <= Math.max(5, p.importe * TOLERANCIA_IMPORTE))
      .sort((a, b) => Math.abs(diasEntre(a.fecha, c.fecha)) - Math.abs(diasEntre(b.fecha, c.fecha)) || Math.abs(a.importe - c.importe) - Math.abs(b.importe - c.importe));
    const pago = candidatos[0];
    if (!pago) continue;
    yaTratados.add(pago.id);
    const importeReal = unaSolaPoliza ? c.importe : pago.importe;
    resultado.actualizaciones.push({
      id: pago.id,
      cambios: {
        estado: "pagado",
        importe: importeReal,
        estimado: unaSolaPoliza ? false : pago.estimado,
        notas: `${pago.notas ? `${pago.notas} · ` : ""}Pagado ${c.fecha.split("-").reverse().join("/")}: ${formatearEuros(c.importe)} ${moneda(pago.moneda)} en ${c.cuenta} (apunte ${c.movimientoId}).`,
      },
    });
    if (pago.recurrenciaMeses > 0) {
      const fechaSiguiente = sumarMeses(pago.fecha, pago.recurrenciaMeses);
      const yaExiste = pagos.some((p) => p.polizaId === pago.polizaId && p.id !== pago.id && p.estado !== "cancelado" && Math.abs(diasEntre(p.fecha, fechaSiguiente)) <= MARGEN_DIAS_SERIE);
      if (!yaExiste) {
        resultado.nuevos.push({
          ...pago,
          id: idPago(pago.polizaId, fechaSiguiente),
          fecha: fechaSiguiente,
          importe: importeReal,
          estimado: true,
          estado: "previsto",
          eventoCalendarId: "",
          avisos: "",
          notas: `Siguiente pago de la serie, generado al confirmarse el del ${pago.fecha.split("-").reverse().join("/")} (${formatearEuros(importeReal)} ${moneda(pago.moneda)}); el importe se confirma con el recibo de la corredora.`,
          actualizadoEn: hoy,
        });
      }
    }
  }
  return resultado;
}
