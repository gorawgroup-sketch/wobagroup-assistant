import type { CompraHoldedCruda } from './write';

/** Solo detecta; no convierte un pago genérico en un ajuste contable de divisa. */
export function detectarResiduoDivisaEUR(
  compra: Pick<CompraHoldedCruda, 'currency'|'currency_change'|'total'|'payments_total'|'payments_pending'|'payments_detail'>,
  movimiento: {status?:string;currency?:string;amount?:string|number;reconciled_amount?:string|number},
  cuenta: string, fecha: string
): number | undefined {
  const numero = (v: unknown) => {
    if (v === null || v === undefined || String(v).trim() === '') return NaN;
    const s=String(v); return Number(s.includes(',')?s.replace(/\./g,'').replace(',','.'):s);
  };
  const cents=(n:number)=>Math.round(n*100);
  if (!compra.currency || compra.currency.toUpperCase()==='EUR' || movimiento.currency!=='EUR' || movimiento.status!=='reconciled') return;
  const total=numero(compra.total), tasa=numero(compra.currency_change), pagado=numero(compra.payments_total), pendiente=numero(compra.payments_pending);
  const cargo=-numero(movimiento.amount), conciliado=-numero(movimiento.reconciled_amount);
  if (![total,tasa,pagado,pendiente,cargo,conciliado].every(n=>Number.isFinite(n)&&n>0)) return;
  if (cents(cargo)!==cents(conciliado) || cents(pagado)+cents(pendiente)!==cents(total)) return;
  // Un único pago del cargo propio, no una suma de otros cargos o anticipos.
  const pagos=compra.payments_detail??[];
  if(pagos.length!==1) return;
  const pago=pagos[0];
  if(pago.bank_id!==cuenta || pago.date!==fecha || cents(numero(pago.amount))!==cents(cargo)) return;
  if(Math.abs(pagado/tasa-cargo)>0.005) return;
  const residuo=cents(pendiente/tasa);
  const margen=Math.ceil(Math.min(1,Math.max(0.02,total/tasa*0.005))*100);
  if(residuo<=0 || residuo>margen || Math.abs(cents(total/tasa-cargo)-residuo)>1) return;
  return residuo/100;
}
