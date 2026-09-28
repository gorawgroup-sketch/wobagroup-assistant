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
export type RecuperacionCompra = 'nueva' | 'conciliada' | 'revision' | 'incierta';
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
  if (!registros.length) return compraTienePagos(await deps.leerCompra(empresa, documentId)) ? 'revision' : 'nueva';
  let revision = false;
  for (const r of registros) {
    const inspeccion = await deps.inspeccionar(r);
    if (inspeccion.estado !== 'verificada') return 'incierta';
    revision ||= conciliacionRequiereRevision(inspeccion.resultado);
  }
  return revision ? 'revision' : 'conciliada';
}
