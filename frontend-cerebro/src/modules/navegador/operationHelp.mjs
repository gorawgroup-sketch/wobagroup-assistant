export const OPERATION_HELP='Puedes pedir la operación aquí. Prepararé un borrador para que revises el texto y confirmes su envío a WOBi. Necesitas este dispositivo vinculado a tu Telegram; las aprobaciones de operaciones financieras o sensibles siguen en Telegram.';
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
