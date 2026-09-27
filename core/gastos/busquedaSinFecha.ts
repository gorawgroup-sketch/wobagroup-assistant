import {esFechaDocumentoValida} from "./fechaDocumento";
import {holdedGet, type Empresa} from '../holded/client';
import {movimientoCompatibleConGasto, type MovimientoBancarioCandidato} from '../holded/write';
export type CandidatoSinFecha = MovimientoBancarioCandidato & {status:string};
/** Recuperar fecha solo con un único cargo compatible; uno ya conciliado se investiga, nunca se reutiliza. */
export function seleccionarFechaBancaria(candidatos:CandidatoSinFecha[]):string|undefined {
 const unicos=[...new Map(candidatos.map(c=>[`${c.accountId}:${c.movementId}`,c])).values()];
 return unicos.length===1 && esFechaDocumentoValida(unicos[0].fecha) ? unicos[0].fecha : undefined;
}
export async function buscarCargoSinFecha(empresa:Empresa, datos:{proveedor:string;concepto:string;monto:number;moneda:string}):Promise<CandidatoSinFecha[]> {
 const hasta=new Date(); const desde=new Date(hasta); desde.setUTCDate(desde.getUTCDate()-90);
 const cuentas:any=await holdedGet(empresa,'/treasury/accounts'); const candidatos:CandidatoSinFecha[]=[];
 for(const cuenta of (cuentas.items??[]).filter((c:any)=>!c.archived)){
  let cursor='';const vistos=new Set<string>();
  do {
   const q=new URLSearchParams({start_date:desde.toISOString().slice(0,10),end_date:hasta.toISOString().slice(0,10),limit:'200',status:'pending,reconciled,partial,forced_reconciled'});
   if(cursor)q.set('cursor',cursor);
   const r:any=await holdedGet(empresa,`/treasury/accounts/${encodeURIComponent(cuenta.id)}/bank-movements?${q}`);
   for(const m of r.items??[]){
    const amount=Number(String(m.amount).replace(',','.'));
    if(!(amount<0)||Math.abs(Math.abs(amount)-datos.monto)>0.005||(m.currency??'EUR').toUpperCase()!==datos.moneda.toUpperCase())continue;
    if(!movimientoCompatibleConGasto(datos.proveedor,datos.concepto,m.description??''))continue;
    candidatos.push({accountId:cuenta.id,movementId:m.id,descripcion:m.description,monto:amount,moneda:m.currency??'EUR',fecha:(m.booking_date??'').slice(0,10),status:m.status});
   }
   if(r.has_more&&(!r.cursor||vistos.has(r.cursor)))throw Error('Búsqueda bancaria incompleta; no se descartan duplicados.');
   cursor=r.has_more?r.cursor:'';if(cursor)vistos.add(cursor);
  }while(cursor);
 }
 return candidatos;
}
