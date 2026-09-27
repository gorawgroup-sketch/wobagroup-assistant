/** Un cargo libre no basta: la compra anterior debe estar pagada y tener otra identidad documental y fecha. */
export function gastoRecurrenteIndependiente(actual: {numeroDocumento?:string;fecha:string}, anterior: {document_number?:string;date?:string;payments_pending?:string;payments_detail?:Array<{date?:string}>}):boolean {
 const numero=(v?:string)=>(v??'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
 const a=numero(actual.numeroDocumento),b=numero(anterior.document_number);
 const utiles=(n:string)=>n.length>=4&&!/^0+$/.test(n)&&!["SINNUMERO","SINDOCUMENTO","UNKNOWN"].includes(n);
 const fechaAnterior=anterior.date?.slice(0,10);
 return utiles(a)&&utiles(b)&&a!==b&&Boolean(fechaAnterior)&&fechaAnterior!==actual.fecha&&
   Boolean(String(anterior.payments_pending??'').trim())&&Number(String(anterior.payments_pending).replace(',','.'))===0&&
   Boolean(anterior.payments_detail?.length)&&anterior.payments_detail!.every(p=>Boolean(p.date)&&p.date!.slice(0,10)!==actual.fecha);
}

/** A probable occupied charge belongs to the independently paid older document,
 * not the new receipt. Call only after verifying a unique unused current charge. */
export function cargoConciliadoDeGastoIndependiente(
 actual: {numeroDocumento?:string;fecha:string},
 anterior: Parameters<typeof gastoRecurrenteIndependiente>[1] & {
   currency?:string; payments_detail?:Array<{date?:string;bank_id?:string;amount?:string|number}>
 },
 cargo: {nivel:string;status:string;fecha:string;moneda:string;monto:number;accountId:string}
):boolean {
 if(!gastoRecurrenteIndependiente(actual,anterior)||cargo.nivel!=='probable'||cargo.status!=='reconciled'||
    cargo.fecha===actual.fecha||anterior.currency?.toUpperCase()!==cargo.moneda.toUpperCase())return false;
 const pagos=anterior.payments_detail??[];
 return pagos.length===1&&pagos[0].date?.slice(0,10)===cargo.fecha&&pagos[0].bank_id===cargo.accountId&&
   Math.abs(Number(String(pagos[0].amount).replace(',','.'))-Math.abs(cargo.monto))<0.005;
}
