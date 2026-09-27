/** Un cargo libre no basta: la compra anterior debe estar pagada y tener otra identidad documental y fecha. */
export function gastoRecurrenteIndependiente(actual: {numeroDocumento?:string;fecha:string}, anterior: {document_number?:string;date?:string;payments_pending?:string;payments_detail?:Array<{date?:string}>}):boolean {
 const numero=(v?:string)=>(v??'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
 const a=numero(actual.numeroDocumento),b=numero(anterior.document_number);
 const utiles=(n:string)=>n.length>=4&&!/^0+$/.test(n);
 const fechaAnterior=anterior.date?.slice(0,10);
 return utiles(a)&&utiles(b)&&a!==b&&Boolean(fechaAnterior)&&fechaAnterior!==actual.fecha&&
   Number(String(anterior.payments_pending??'').replace(',','.'))===0&&anterior.payments_pending!==undefined&&
   Boolean(anterior.payments_detail?.length)&&anterior.payments_detail!.every(p=>Boolean(p.date)&&p.date!.slice(0,10)!==actual.fecha);
}
