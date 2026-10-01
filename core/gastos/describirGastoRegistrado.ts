/**
 * Texto legible de un gasto ya registrado, para los avisos al operador.
 *
 * Pedido de Carlos (2026-10-01): «ese número de referencia es un código que a mí no me dice nada». Un aviso debe decir
 * de qué gasto se trata —proveedor, importe y empresa—, no su identificador interno de Holded. El id solo se muestra
 * cuando no hay nada mejor que mostrar.
 */
export function describirGastoRegistrado(registro: {
  gastoId: string;
  empresa: string;
  identidad?: { proveedor?: string; monto?: number; moneda?: string; fecha?: string };
}): string {
  const i = registro.identidad;
  const proveedor = i?.proveedor?.trim();
  if (!proveedor) return `gasto con referencia ${registro.gastoId} (${registro.empresa})`;
  const importe = typeof i?.monto === "number" && Number.isFinite(i.monto)
    ? ` — ${i.monto.toFixed(2).replace(".", ",")} ${i.moneda?.trim() || "EUR"}` : "";
  const fecha = i?.fecha?.trim() ? `, ${i.fecha.trim()}` : "";
  return `${proveedor}${importe}${fecha} (${registro.empresa})`;
}
