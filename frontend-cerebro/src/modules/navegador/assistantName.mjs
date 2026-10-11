// Corrige el error observado del dictado solo cuando «Guapi» funciona como vocativo.
// No modifica Guapi como lugar, proveedor, documento ni término dentro de una consulta.
export function normalizeAssistantName(text){
 if(typeof text!=='string')return text;
 return text
  .replace(/^([\s¿¡]*(?:hola|buenas|buenos días|buenos dias|buenas tardes|buenas noches|gracias)[\s,¡!¿?]+)guapi\b/iu,'$1WOBi')
  .replace(/^([\s¿¡]*)guapi(?=\s*[,!?]|\s+(?:abre|mu[eé]strame|busca|puedes|podr[ií]as|c[oó]mo|qu[eé]|revisa|crea|ay[uú]dame)\b|\s*$)/iu,'$1WOBi')
  .replace(/^([\s¿¡]*(?:c[oó]mo est[aá]s|qu[eé] tal|qui[eé]n eres|pres[eé]ntate)[\s,]+)guapi(\s*[.!?]*\s*)$/iu,'$1WOBi$2');
}
