const TYPES={seguros_pagos_pendientes:'pagos_pendientes',seguros_proximas_renovaciones:'proximas_renovaciones',seguros_actividad:'actividad'};
const strings=x=>Array.isArray(x)&&x.every(v=>typeof v==='string');
export function validateConversationResponse(result,companies){
  if(result.modo!=='deterministico'||typeof result.conversacionId!=='string'||!result.conversacionId||result.conversacionId.length>200||typeof result.resumen!=='string'||!result.resumen.trim())return false;
  const l=result.lectura;if(!l)return true;
  if(!TYPES[l.tipo]||!['completa','incompleta','no_consultable'].includes(l.estado)||typeof l.refrescando!=='boolean'||!strings(l.avisos)||!Array.isArray(l.fuentes))return false;
  if(!l.fuentes.every(f=>f&&typeof f.fuente==='string'&&typeof f.ok==='boolean'&&typeof f.conservado==='boolean'&&(f.ultimoExitoEn===null||typeof f.ultimoExitoEn==='string')))return false;
  if(l.leidoEn!==null&&(typeof l.leidoEn!=='string'||!Number.isFinite(Date.parse(l.leidoEn))))return false;
  if(l.tipo==='seguros_actividad'?l.empresa!==null:!companies.includes(l.empresa)||l.empresa!==result.companyId)return false;
  if(result.capabilityId!==`section:insurance:seguros:${TYPES[l.tipo]}`)return false;
  if(l.estado==='no_consultable')return result.tipo==='no_disponible'&&l.items===undefined&&l.total===undefined&&l.mostrados===undefined;
  if(l.total!==undefined&&(l.estado!=='completa'||!Number.isInteger(l.total)||l.total<0))return false;
  return l.items===undefined||(Array.isArray(l.items)&&l.items.length<=10&&l.items.every(v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.values(v).every(x=>typeof x==='string'||(typeof x==='number'&&Number.isFinite(x)))));
}
export function readingDate(value){
  return value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',dateStyle:'short',timeStyle:'medium'}).format(new Date(value)):'Sin fecha de lectura verificada';
}
