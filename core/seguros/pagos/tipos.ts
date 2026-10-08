/**
 * Calendario de pagos de seguros (docs/wobi-seguros.md §6.2): una fila por pago futuro (fecha, importe, cuenta de cargo), en vez de la
 * única `fechaVencimiento` de cada póliza. Es lo que permite avisar 3 días antes con la comprobación de caja y poner el evento en el
 * calendario de Carlos. Sin IA: todo es cálculo directo sobre estos datos y los saldos de Holded.
 */
import type { Empresa } from "../../holded/client";

export type EstadoPagoCalendario = "previsto" | "pagado" | "devuelto" | "cancelado";
export type FormaPago = "adeudo" | "transferencia" | "desconocida";

export interface PagoSeguro {
  /** Estable y legible: `<póliza>:<fecha>` (la siembra y la recurrencia son idempotentes por este id). */
  id: string;
  polizaId: string;
  empresa: Empresa;
  /** YYYY-MM-DD: el día en que se cobra el adeudo o hay que hacer la transferencia. */
  fecha: string;
  importe: number;
  moneda: string;
  /** true: el importe es una estimación (el último recibo o lo que anuncia la corredora); se confirma con el recibo real. */
  estimado: boolean;
  concepto: string;
  /** Nombre EXACTO de la cuenta en Holded (es como se encuentra su saldo): «BBVA», «CAIXA BANK EWORKS», «Main»… */
  cuentaDeCargo: string;
  forma: FormaPago;
  estado: EstadoPagoCalendario;
  /** Meses hasta el siguiente pago de la misma serie (0 = ninguno; 12 anual; 6 semestral…). Al confirmarse se genera el siguiente. */
  recurrenciaMeses: number;
  /** Evento del calendario de Carlos (3 días antes). Vacío = aún sin evento. */
  eventoCalendarId: string;
  /** Avisos de Telegram ya enviados para este pago: «d3», «d1» (separados por coma). */
  avisos: string;
  notas: string;
  actualizadoEn: string;
}

export interface PagoSeguroConFila extends PagoSeguro {
  rowIndex: number;
}

export const DIAS_AVISO_PAGO = 3;
/** Los eventos de calendario se crean solo para pagos dentro de este horizonte. */
export const HORIZONTE_EVENTOS_DIAS = 400;
