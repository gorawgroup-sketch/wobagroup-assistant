export const OPERATION_HELP='Si necesitas ejecutar una operación, debes hacerlo con WOBi a través del chat de Telegram. Aquí puedo orientarte y consultar las vistas disponibles. ¿Quieres que te abra el chat de Telegram?';
const normalize=text=>typeof text==='string'?text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[¿?¡!.,]/g,' ').replace(/\b(wobi|woby|wobby|wovi|wowi)\b/g,' ').replace(/\s+/g,' ').trim():'';
export function operationHelp(text){
 const q=normalize(text);
 return /^(?:si )?(?:necesito|quiero|tengo que) (?:ejecutar|hacer|realizar|procesar) (?:una |alguna )?operacion(?: |$)/.test(q)||/^(?:como|donde) (?:puedo )?(?:ejecutar|hacer|realizar|procesar) (?:una |alguna )?operacion(?: |$)/.test(q)||/^(?:me )?puedes ayudar(?:me)? con (?:una |alguna )?operacion$/.test(q);
}
export function telegramConfirmation(text){
 const q=normalize(text);
 if(/^(?:si(?: claro| por favor)?|claro|abrelo|abrir telegram|abre telegram|si abrelo)$/.test(q))return true;
 if(/^(?:no(?: gracias)?|ahora no|seguir aqui)$/.test(q))return false;
 return null;
}
