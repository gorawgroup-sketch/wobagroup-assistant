import type { CompraHoldedCruda } from './write';
import type { RegistroConciliacionMovimiento, InspeccionConciliacionMovimiento } from './durableBankReconciliation';
import { conciliacionRequiereRevision } from './durableBankReconciliation';
import type { Empresa } from './client';

export function compraTienePagos(compra: CompraHoldedCruda): boolean {
  const total = String(compra.payments_total ?? '').trim();
  const numero = Number(total.includes(',') ? total.replace(/\./g, '').replace(',', '.') : total);
  // Un dato ausente no acredita que sea seguro escribir.
  return Boolean(compra.payments_detail?.length) || !total || !Number.isFinite(numero) || numero !== 0;
}
/**
 * La compra ya está pagada POR COMPLETO en Holded y Wobi no tiene registrada ninguna conciliación suya: el pago se
 * hizo fuera (a mano o por la gestoría). Caso real (Carlos, 2026-10-01, Raminatrans 6.892,73 €, eWorks): la factura
 * ya estaba pagada desde el 08/09; al adjuntarle el soporte, el sistema respondía «la compra ya tiene pagos, requiere
 * revisión» y ofrecía «Retomar conciliación», un bucle sin salida, cuando no quedaba nada que conciliar.
 */
export function compraPagadaPorCompleto(compra: CompraHoldedCruda): boolean {
  const numero = (valor: unknown) => {
    const texto = String(valor ?? '').trim();
    return texto ? Number(texto.includes(',') ? texto.replace(/\./g, '').replace(',', '.') : texto) : NaN;
  };
  const total = numero(compra.total), pagado = numero(compra.payments_total), pendiente = numero(compra.payments_pending);
  if (![total, pagado, pendiente].every(Number.isFinite) || total <= 0 || !compra.payments_detail?.length) return false;
  // Mismo margen de redondeo de conversión que usa el resto de la conciliación (0,5 %, entre 2 céntimos y 1 unidad).
  const margen = Math.min(1, Math.max(0.02, total * 0.005));
  return Math.abs(pendiente) <= margen && Math.abs(pagado - total) <= margen;
}
export type RecuperacionCompra = 'nueva' | 'conciliada' | 'pagada_externamente' | 'revision' | 'incierta';
/** Recupera SOLO operaciones registradas para esta compra. Nunca busca otro cargo ni escribe pagos. */
export async function recuperarConciliacionCompra(
  empresa: Empresa, documentId: string,
  deps: {
    leerCompra: (empresa: Empresa, id: string) => Promise<CompraHoldedCruda>;
    listar: (empresa: Empresa, id: string) => Promise<RegistroConciliacionMovimiento[]>;
    inspeccionar: (registro: RegistroConciliacionMovimiento) => Promise<InspeccionConciliacionMovimiento>;
  }
): Promise<RecuperacionCompra> {
  const registros = (await deps.listar(empresa, documentId))
    .filter(r => r.empresa === empresa && r.documentId === documentId && r.estado !== 'cancelada' && r.estado !== 'preparada');
  if (!registros.length) {
    const compra = await deps.leerCompra(empresa, documentId);
    if (!compraTienePagos(compra)) return 'nueva';
    return compraPagadaPorCompleto(compra) ? 'pagada_externamente' : 'revision';
  }
  let revision = false;
  for (const r of registros) {
    const inspeccion = await deps.inspeccionar(r);
    if (inspeccion.estado !== 'verificada') return 'incierta';
    revision ||= conciliacionRequiereRevision(inspeccion.resultado);
  }
  return revision ? 'revision' : 'conciliada';
}
