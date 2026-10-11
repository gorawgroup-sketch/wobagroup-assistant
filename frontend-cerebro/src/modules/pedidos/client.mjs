const BASE='/api/cerebro/pedidos';
export const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{16,64}$/.test(id);
export const activePedido=p=>['recibido','procesando'].includes(p?.estado);
const execution={pendiente_confirmacion:'no_enviada',recibido:'pendiente',procesando:'en_curso',terminado:'finalizada',fallido:'incierta',cancelado:'no_enviada',expirado:'no_enviada'};
export function validatePedido(p,id){
 if(!p||p.pedidoId!==id||!validId(id)||!/^[A-F0-9]{8}$/.test(p.ref)||typeof p.mensaje!=='string'||execution[p.estado]!==p.ejecucion||!execution[p.estado])throw Error('Respuesta del pedido no válida. Consulta su estado antes de continuar.');
 if(p.estado==='pendiente_confirmacion'&&(typeof p.texto!=='string'||!p.texto.trim()||p.texto.length>4000||typeof p.textoHash!=='string'||!/^[a-f0-9]{64}$/.test(p.textoHash)||!Number.isFinite(Date.parse(p.expiraEn))))throw Error('Borrador no válido. No se ha confirmado ningún envío.');
 return p;
}
export function createPedidosClient({headers,fetcher=fetch}){
 const read=async(path,{method='GET',body,signal}={})=>{
  const response=await fetcher(path,{method,headers:{...headers,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal,cache:'no-store'});
  let data;try{data=await response.json();}catch{throw Error('Respuesta no válida. Consulta el estado; no envíes un pedido nuevo.');}
  if(!response.ok){const error=Error(typeof data.error==='string'?data.error:`No se pudo consultar (${response.status}).`);error.codigo=data.codigo;error.status=response.status;throw error;}
  return data;
 };
 const byId=id=>{if(!validId(id))throw Error('Identificador de pedido no válido.');return `${BASE}/${id}`;};
 return {
  availability:async signal=>{const d=await read(`${BASE}/disponibilidad`,{signal});if(typeof d.disponible!=='boolean'||(!d.disponible&&!['sin_vinculo','apagado','entrega_durable_apagada'].includes(d.motivo)))throw Error('Disponibilidad no válida. No se puede enviar.');return d;},
  draft:async(texto,pedidoId,signal)=>{byId(pedidoId);const p=validatePedido(await read(BASE,{method:'POST',body:{texto,pedidoId},signal}),pedidoId);if(p.estado==='pendiente_confirmacion'&&p.texto!==texto)throw Error('El texto del borrador no coincide. No confirmes el envío.');return p;},
  confirm:async(p,signal)=>validatePedido(await read(`${byId(p.pedidoId)}/confirmar`,{method:'POST',body:{textoHash:p.textoHash},signal}),p.pedidoId),
  cancel:async(id,signal)=>validatePedido(await read(`${byId(id)}/cancelar`,{method:'POST',body:{},signal}),id),
  status:async(id,signal)=>validatePedido(await read(byId(id),{signal}),id),
  link:async signal=>{const d=await read('/api/cerebro/chat/vincular',{method:'POST',body:{},signal});if(d.estado!=='vinculado'&&(d.estado!=='pendiente'||typeof d.codigo!=='string'||!/^[a-zA-Z0-9-]{6,8}$/.test(d.codigo)||!Number.isFinite(d.expiraEn)))throw Error('Código de vinculación no válido.');return d;},
  history:signal=>read('/api/cerebro/chat',{signal})
 };
}
// Solo referencias opacas: nunca texto, hash de confirmación ni credenciales.
export function pedidoStorageKey(headers){return `wobi_pedido:${encodeURIComponent(headers['X-Cerebro-Device']||'')}:${encodeURIComponent(headers['X-Cerebro-Nombre']||'')}`;}
export function loadPedidoId(storage,key){try{const id=storage.getItem(key);return validId(id)?id:null;}catch{return null;}}
export function savePedidoId(storage,key,id){try{if(id)storage.setItem(key,id);else storage.removeItem(key);return true;}catch{return false;}}
export function historyAfterRef(history,ref){
 if(!/^[A-F0-9]{8}$/.test(ref)||!Array.isArray(history?.mensajes))return [];
 const messages=history.mensajes.filter(m=>['usuario','wobi'].includes(m?.rol)&&typeof m.texto==='string');
 const marker=`Pedido desde el front (ref. ${ref}):`;
 const start=messages.findIndex(m=>m.rol==='wobi'&&m.texto.includes(marker));
 if(start<0)return [];
 const result=[];let skippedUser=false;
 for(const m of messages.slice(start+1)){
  if(m.texto.includes('Pedido desde el front (ref. '))break;
  if(m.rol==='usuario'){if(skippedUser||result.length)break;skippedUser=true;continue;}
  result.push(m);
 }
 return result;
}

// Solo un 404 de consulta con este código permite olvidar una referencia.
export function forgetMissingPedido(error,storage,key){
 if(error?.status!==404||error?.codigo!=='pedido_no_encontrado')return false;
 savePedidoId(storage,key,null);return true;
}
