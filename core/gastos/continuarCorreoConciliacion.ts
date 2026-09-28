import type { InlineKeyboardButton } from '../telegram/types';
import type { IdentidadCorreoCola } from '../gmail/colaRevisionStore';
type Pendiente = {id:string;chatId:number;deColaCorreo?:boolean;threadIdGmail?:string;mensajeIdGmail?:string};
export function botonContinuarConciliacion(p:Pendiente, ambigua=false):InlineKeyboardButton[][] {
  if(!p.deColaCorreo||!p.threadIdGmail||!p.mensajeIdGmail)return [];
  return [[{text:'➡️ Dejar saldo pendiente y seguir',callback_data:`gasto_conciliar_posponer:${p.id}:${ambigua?'ambigua':'simple'}`}]];
}
/** No consume la decisión ni toca Holded/Gmail: delega el aplazamiento exacto ya coordinado. */
export async function continuarCorreoConciliacion(chat:number,id:string,pendientes:Pendiente[],posponer:(chat:number,identidad:IdentidadCorreoCola)=>Promise<string>):Promise<string>{
  const p=pendientes.find(p=>p.id===id&&p.chatId===chat);
  if(!p?.deColaCorreo||!p.threadIdGmail||!p.mensajeIdGmail)return 'No hay un correo exacto pendiente para este botón.';
  return posponer(chat,{threadId:p.threadIdGmail,mensajeId:p.mensajeIdGmail});
}
