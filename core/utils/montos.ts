/**
 * Compara dos montos en euros con tolerancia, en CÉNTIMOS enteros — nunca
 * resta los floats directamente. Bug real encontrado en vivo (verificado
 * contra un caso real de conversión USD→EUR): en JS, 7964.17 - 7964.16 =
 * 0.010000000000218279 (error de precisión de punto flotante), que queda
 * POR ENCIMA de una tolerancia de 0.01 aunque la diferencia real sea
 * exactamente un céntimo — un match legítimo se perdía por cómo se
 * representan los decimales en punto flotante, no por una diferencia real
 * entre los montos. Toda comparación de montos con tolerancia en el
 * proyecto debería pasar por aquí en vez de restar floats a mano.
 */
export function montosCercanos(a: number, b: number, toleranciaEur: number): boolean {
  const centavosA = Math.round(a * 100);
  const centavosB = Math.round(b * 100);
  return Math.abs(centavosA - centavosB) <= Math.round(toleranciaEur * 100);
}
