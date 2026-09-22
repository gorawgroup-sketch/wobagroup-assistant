import type { BloqueEscritura } from "./cashflowWrite";

/** Únicamente destinos que el escritor de cash flow admite actualmente. */
export const AREAS_PROPUESTA_CASHFLOW: Array<{ bloque: BloqueEscritura; etiqueta: string }> = [
  { bloque: "ingresos", etiqueta: "Ingresos" },
  { bloque: "pagos_proyectos", etiqueta: "Pagos Proyectos" },
  { bloque: "pagos_extras", etiqueta: "Pagos Extras" },
  { bloque: "gastos_fijos", etiqueta: "Gastos Fijos" },
  { bloque: "pagos_pendientes_alberto", etiqueta: "Pagos pendientes Alberto" },
  { bloque: "deudas_pendientes", etiqueta: "Deudas pendientes" },
];

export function botonesAreasCashflow(id: string) {
  return [
    ...AREAS_PROPUESTA_CASHFLOW.map(a => [{ text: `Registrar en ${a.etiqueta}`, callback_data: `cf_approve:${id}:${a.bloque}` }]),
    [{ text: "❌ No registrar", callback_data: `cf_reject:${id}` }],
  ];
}

export function esCambioDivisaCashflow(descripcion: string): boolean {
  return /\b(?:exchanged|converted)\b.*\bto\b|cambio de (?:moneda|divisa)/i.test(descripcion);
}
