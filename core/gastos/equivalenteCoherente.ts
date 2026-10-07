/**
 * ¿El equivalente que trae el documento o el correo cuadra con la tasa de cambio del día? Pura.
 *
 * Caso real (Footprint, Hospedaje Guadalajara, 2026-10-07): el recibo era de 4.036,92 MXN (≈ 204,65 EUR, y ese fue el cargo del banco), pero
 * en el hilo reenviado alguien comentó «al revisar esto en cuenta corresponde a 174,60€». Wobi tomó esa cifra como equivalente explícito,
 * que tiene prioridad sobre buscar el cargo en el banco, y propuso crear el gasto por 174,60 € (otro importe, de otra reserva).
 *
 * El spread de una tarjeta ronda el 1-4 %. Un equivalente que se aparta más del 8 % de lo que da la tasa del día no es una conversión: se
 * ignora y se busca el cargo real en el banco. Si no hay tasa, no se puede juzgar y el equivalente se conserva.
 */
export const TOLERANCIA_EQUIVALENTE = 0.08;

export function equivalenteCuadraConTasa(params: { monto: number; equivalente: number; tasa: number | undefined; tolerancia?: number }): boolean {
  const { monto, equivalente, tasa, tolerancia = TOLERANCIA_EQUIVALENTE } = params;
  if (tasa === undefined || !Number.isFinite(tasa) || tasa <= 0) return true;
  if (!Number.isFinite(monto) || !Number.isFinite(equivalente) || monto <= 0 || equivalente <= 0) return true;
  const esperado = Math.abs(monto) * tasa;
  return Math.abs(Math.abs(equivalente) - esperado) / esperado <= tolerancia;
}
