// Orientación, no autorización ni ejecución de una revisión financiera.
export const FINANCIAL_HELP='No puedo revisar ni analizar los estados financieros desde esta interfaz. Puedes solicitar esa revisión a WOBi en Telegram, donde se comprobarán los permisos y la información disponible. ¿Quieres que abra el chat? Conservaré tu solicitud para que puedas copiarla; todavía no se enviará automáticamente.';
export function financialHelp(text){
 if(typeof text!=='string')return false;
 const q=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 return /\b(?:revisar|revisa|analizar|analiza|evaluar|evalua)\b/.test(q)&&/\b(?:estados? financieros?|balance(?:s)? contables?|cuentas anuales)\b/.test(q);
}
