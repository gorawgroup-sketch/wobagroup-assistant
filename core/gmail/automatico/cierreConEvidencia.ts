import { identidadCreacionCompra } from "../../holded/durablePurchase";
import { monedaRegistroPlanAuto, type OperacionAuto } from "./model";

/**
 * Cierre de una operación automática que quedó sin estado terminal aunque Holded ya refleje el
 * resultado completo (caso JetBlue, 2026-09-28: compra creada, pagada y con comprobante, pero la
 * operación siguió «pendiente de verificar» y bloqueó la revisión manual del correo).
 *
 * La verificación estricta del flujo automático compara campo por campo (cuenta, impuestos, tasa,
 * etiquetas…) y no distingue «alguien corrigió el gasto» de «la compra es otra». Aquí se exige otra
 * cosa, mucho más pequeña y suficiente para decir «esto ya quedó registrado»: que la compra sea
 * demostrablemente de ESTA operación, del mismo proveedor, moneda e importe, con el pago cubierto por
 * el cargo previsto, un comprobante adjunto y el movimiento bancario conciliado. Solo lecturas.
 */

/** Lo mínimo que hay que leer de Holded para decidir. Todo son lecturas; nada se escribe. */
export interface HechosCierre {
  compra: {
    id: string;
    notas: string;
    contactoId: string;
    moneda: string;
    totalCentimos: number;
    pagadoCentimos: number;
    pendienteCentimos: number;
    pagos: Array<{ bancoId: string; centimos: number }>;
  } | null;
  adjuntos: number;
  /** null = el movimiento no se encontró en la ventana consultada. */
  movimiento: { estado: string } | null;
}

export type ComprobacionCierre =
  | "identidad" | "contacto" | "moneda" | "total"
  | "pagoCompleto" | "pagoEnLaCuentaPrevista" | "comprobante" | "movimientoConciliado";

export interface EvaluacionCierre {
  /**
   * completa: todo lo que debía escribir la operación ya está en Holded → se puede cerrar.
   * parcial: la compra es de esta operación pero falta el pago, el comprobante o la conciliación.
   * no_concluyente: no se pudo demostrar que la compra sea la de esta operación o no coincide.
   */
  veredicto: "completa" | "parcial" | "no_concluyente";
  comprobaciones: Record<ComprobacionCierre, boolean>;
  faltan: ComprobacionCierre[];
}

const ETIQUETAS: Record<ComprobacionCierre, string> = {
  identidad: "la compra no lleva la marca de esta operación",
  contacto: "el proveedor de la compra es otro",
  moneda: "la moneda de la compra es otra",
  total: "el importe de la compra es otro",
  pagoCompleto: "el gasto no está pagado por completo",
  pagoEnLaCuentaPrevista: "el pago no salió de la cuenta bancaria prevista",
  comprobante: "no tiene comprobante adjunto",
  movimientoConciliado: "el movimiento bancario no figura como conciliado",
};

export const describirFaltanteCierre = (c: ComprobacionCierre): string => ETIQUETAS[c];

const ESTADOS_CONCILIADO = new Set(["reconciled", "forced_reconciled"]);

/** Marcas con las que el flujo automático deja identificada su compra en Holded. */
export function marcasDeOperacion(op: OperacionAuto): string[] {
  const marcas = [`WOBI_AUTO:${op.id}`];
  try {
    // La clave idempotente es la misma que usa `crear` en flujoExistente; el marcador solo depende de ella.
    marcas.push(identidadCreacionCompra(`correo-auto:${op.id}`, op.plan.empresa, op.plan.contactoId,
      op.plan.recibo.fecha, {}).marcador);
  } catch { /* un plan sin contacto o fecha válidos no puede derivar marcador; queda solo la marca antigua */ }
  return marcas;
}

export function evaluarEvidenciaCierre(op: OperacionAuto, hechos: HechosCierre): EvaluacionCierre {
  const p = op.plan;
  const documento = monedaRegistroPlanAuto(p);
  const c = hechos.compra;
  const comprobaciones: Record<ComprobacionCierre, boolean> = {
    identidad: Boolean(c && op.compraId && c.id === op.compraId &&
      marcasDeOperacion(op).some(marca => c.notas.includes(marca))),
    contacto: Boolean(c && c.contactoId === p.contactoId),
    moneda: Boolean(c && c.moneda.toUpperCase().trim() === documento.moneda.toUpperCase().trim()),
    total: Boolean(c && c.totalCentimos === Math.round(documento.monto * 100)),
    pagoCompleto: Boolean(c && c.totalCentimos > 0 && c.pendienteCentimos === 0 && c.pagadoCentimos === c.totalCentimos),
    pagoEnLaCuentaPrevista: Boolean(c && c.pagos.length > 0 && c.pagos.every(x => x.bancoId === p.movimiento.cuentaId)),
    comprobante: hechos.adjuntos > 0,
    movimientoConciliado: Boolean(hechos.movimiento && ESTADOS_CONCILIADO.has(hechos.movimiento.estado)),
  };
  const faltan = (Object.keys(comprobaciones) as ComprobacionCierre[]).filter(k => !comprobaciones[k]);
  // Sin identidad, contacto, moneda e importe no se puede afirmar nada sobre esta compra.
  const esDeEstaOperacion = comprobaciones.identidad && comprobaciones.contacto &&
    comprobaciones.moneda && comprobaciones.total;
  return {
    veredicto: !esDeEstaOperacion ? "no_concluyente" : faltan.length ? "parcial" : "completa",
    comprobaciones,
    faltan,
  };
}
