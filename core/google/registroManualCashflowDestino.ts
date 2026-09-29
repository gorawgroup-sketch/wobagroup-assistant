import { BLOQUES_SECCION_COMPARTIDA, bloqueTieneColumnaEmpresa, type BloqueEscritura } from "./cashflowWrite";
import { AREAS_PROPUESTA_CASHFLOW } from "./cashflowProposalButtons";

/**
 * Pedido explícito de Carlos (2026-09-29): la propuesta de registro manual solo ofrecía «Confirmar» en el bloque que
 * eligió el asistente; si el registro iba en otra área había que escribirlo («ponlo en pagos extras») y esperar una
 * propuesta nueva. Ahora la misma propuesta ofrece todas las áreas que el escritor de cashflow admite.
 */
export interface DatosDestinoRegistroManual {
  empresa: string;
  bloque: BloqueEscritura;
  clienteOConcepto: string;
  semana?: string;
  valor: number;
  resumen: string;
}

const esCompartida = (bloque: BloqueEscritura) => (BLOQUES_SECCION_COMPARTIDA as string[]).includes(bloque);

export function etiquetaAreaCashflow(bloque: BloqueEscritura): string {
  return AREAS_PROPUESTA_CASHFLOW.find((a) => a.bloque === bloque)?.etiqueta ?? bloque;
}

/** Áreas a las que este registro puede ir: sin semana solo valen las secciones que no la exigen. */
export function areasDisponiblesRegistroManual(tieneSemana: boolean): BloqueEscritura[] {
  return AREAS_PROPUESTA_CASHFLOW.map((a) => a.bloque).filter((b) => tieneSemana || esCompartida(b));
}

export function esAreaValidaRegistroManual(bloque: string, tieneSemana: boolean): bloque is BloqueEscritura {
  return (areasDisponiblesRegistroManual(tieneSemana) as string[]).includes(bloque);
}

export function botonesRegistroManualCashflow(id: string, bloquePropuesto: BloqueEscritura, tieneSemana: boolean) {
  const otras = areasDisponiblesRegistroManual(tieneSemana).filter((b) => b !== bloquePropuesto);
  return [
    [{ text: `✅ Confirmar en ${etiquetaAreaCashflow(bloquePropuesto)}`, callback_data: `regmanualcf_confirmar:${id}` }],
    ...otras.map((b) => [{ text: `↪️ Mejor en ${etiquetaAreaCashflow(b)}`, callback_data: `regmanualcf_confirmar:${id}:${b}` }]),
    [{ text: "❌ Cancelar", callback_data: `regmanualcf_cancelar:${id}` }],
  ];
}

/**
 * Cambia el área de destino conservando el resto. La empresa va dentro del concepto solo en los bloques sin columna
 * propia de empresa, así que el prefijo se quita o se añade según el área nueva.
 */
export function aplicarDestinoRegistroManual<T extends DatosDestinoRegistroManual>(pendiente: T, bloque: BloqueEscritura): T {
  if (bloque === pendiente.bloque) return pendiente;
  const prefijo = `${pendiente.empresa} — `;
  const conceptoBase = !bloqueTieneColumnaEmpresa(pendiente.bloque) && pendiente.clienteOConcepto.startsWith(prefijo)
    ? pendiente.clienteOConcepto.slice(prefijo.length)
    : pendiente.clienteOConcepto;
  const clienteOConcepto = bloqueTieneColumnaEmpresa(bloque) ? conceptoBase : `${prefijo}${conceptoBase}`;
  const resumen = `${clienteOConcepto}${pendiente.semana ? ` — semana ${pendiente.semana}` : ""}, ` +
    `${pendiente.valor.toFixed(2)} (bloque "${bloque}")`;
  return { ...pendiente, bloque, clienteOConcepto, resumen };
}
