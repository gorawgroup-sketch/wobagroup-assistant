export const TELEGRAM_CHAT_URL='https://web.telegram.org/k/#@Woba_asistente_bot';
export const TELEGRAM_PROCESSING_MESSAGE='Esta solicitud debe procesarse con WOBi en Telegram. Voy a llevarte a su chat para continuar allí. Tu petición no se ha enviado: puedes copiarla y enviarla desde Telegram.';
// Solo intenciones operativas explícitas. Un fallo, una consulta o un agente previsto no son una derivación.
export function requiresTelegram(text){
 if(typeof text!=='string')return false;
 const q=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[¿?¡!.,]/g,' ').replace(/\b(wobi|wobby|wovi)\b/g,' ').replace(/\s+/g,' ').trim().replace(/^(por favor )?(?:puedes |podrias |quiero que |necesito que )?/,'');
 return /^(?:abre|abrir|llevame|vamos)(?: el| al)? (?:chat de )?telegram$/.test(q)||/^(?:crea|crear|crear una|registra|registrar|prepara|preparar)\b.{0,80}\b(?:factura|facturas|gasto|gastos)\b/.test(q)||/^(?:revisa|revisar|procesa|procesar)\b.{0,80}\b(?:correo|correos|bandeja de entrada)\b/.test(q)||/^(?:concilia|conciliar|reconcilia|reconciliar)\b.{0,80}\b(?:movimiento|movimientos|operacion|operaciones|cuenta|cuentas)\b/.test(q);
}
export function openTelegram(open=(...args)=>globalThis.open(...args)){
 let tab;
 try{tab=open('about:blank','_blank');if(!tab)return false;tab.opener=null;tab.location.replace(TELEGRAM_CHAT_URL);return true;}
 catch{try{tab?.close();}catch{}return false;}
}
