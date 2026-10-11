import test from 'node:test';import assert from 'node:assert/strict';
import {createPedidosClient,validatePedido,historyAfterRef,pedidoStorageKey,loadPedidoId,savePedidoId,activePedido,forgetMissingPedido} from './modules/pedidos/client.mjs';
import {wantsTelegramChat,requiresTelegram} from './modules/navegador/telegram.mjs';
const id='1234567890123456',ref='AABBCCDD',hash='a'.repeat(64),texto='¿Qué pagos de seguros hay pendientes?';
const draft={pedidoId:id,ref,estado:'pendiente_confirmacion',ejecucion:'no_enviada',mensaje:'Revisa',texto,textoHash:hash,expiraEn:'2099-01-01T00:00:00Z'};
const status={pedidoId:id,ref,estado:'recibido',ejecucion:'pendiente',mensaje:'Registrado'};
const headers={'X-Cerebro-Key':'key','X-Cerebro-Device':'device','X-Cerebro-Nombre':'Carlos'};
const fixture=(data,ok=true,status=200)=>({ok,status,json:async()=>data});
test('borrador y confirmación llevan identidad existente, texto exacto y mismo id/hash; nunca datos de rol o chat',async()=>{
 const calls=[];const client=createPedidosClient({headers,fetcher:async(url,options)=>{calls.push({url,...options});return fixture(url.endsWith('/confirmar')?status:draft);}});
 const d=await client.draft(texto,id);await client.confirm(d);await client.confirm(d);
 assert.deepEqual(JSON.parse(calls[0].body),{texto,pedidoId:id});assert.deepEqual(JSON.parse(calls[1].body),{textoHash:hash});assert.equal(calls[1].url,calls[2].url);
 for(const c of calls){assert.equal(c.headers['X-Cerebro-Device'],'device');assert.equal(c.cache,'no-store');}
});
test('texto distinto y borrador/hash/estado/identificador inválidos no se aceptan',async()=>{
 for(const p of [{...draft,textoHash:'x'},{...draft,expiraEn:null},{...draft,ejecucion:'finalizada'},{...draft,pedidoId:'other'},{...draft,estado:'inventado'}])assert.throws(()=>validatePedido(p,id));
 const c=createPedidosClient({headers,fetcher:async()=>fixture({...draft,texto:'otro'})});await assert.rejects(c.draft(texto,id),/no coincide/);
});
test('errores de permisos, cuotas y recepción son explícitos; ningún reenvío automático',async()=>{
 let calls=0;const c=createPedidosClient({headers,fetcher:async()=>{calls++;return fixture({error:'Vincula',codigo:'sin_vinculo'},false,403);}});
 await assert.rejects(c.draft(texto,id),e=>e.codigo==='sin_vinculo'&&e.status===403);assert.equal(calls,1);
});
test('consulta, cancelación y disponibilidad no ejecutan confirmación',async()=>{
 const calls=[];const c=createPedidosClient({headers,fetcher:async(url,options)=>{calls.push([url,options.method]);return fixture(url.endsWith('disponibilidad')?{disponible:false,motivo:'sin_vinculo'}:status);}});
 await c.availability();await c.status(id);await c.cancel(id);assert.deepEqual(calls.map(c=>c[1]),['GET','GET','POST']);assert.ok(calls.every(c=>!c[0].endsWith('confirmar')));
});
test('persistencia guarda solo el id; una sesión distinta no recupera el pedido',()=>{
 const map=new Map();const storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const key=pedidoStorageKey(headers);savePedidoId(storage,key,id);assert.equal(loadPedidoId(storage,key),id);assert.equal(loadPedidoId(storage,pedidoStorageKey({...headers,'X-Cerebro-Device':'otro'})),null);assert.deepEqual([...map.values()],[id]);savePedidoId(storage,key,null);assert.equal(loadPedidoId(storage,key),null);
});
test('resultado incierto es terminal y no se transforma en terminado',()=>{
 assert.equal(activePedido(status),true);assert.equal(activePedido({...status,estado:'fallido'}),false);assert.equal(validatePedido({...status,estado:'fallido',ejecucion:'incierta',detalle:'resultado_incierto'},id).estado,'fallido');
});
test('historial exige referencia real, mantiene texto literal y corta antes de otra conversación',()=>{
 const h={mensajes:[{rol:'wobi',texto:'previo'},{rol:'wobi',texto:`📲 Pedido desde el front (ref. ${ref}): «x»`},{rol:'usuario',texto:'x'},{rol:'wobi',texto:'<img src=x> respuesta'},{rol:'usuario',texto:'otro turno'},{rol:'wobi',texto:'otra respuesta'}]};
 assert.deepEqual(historyAfterRef(h,ref),[{rol:'wobi',texto:'<img src=x> respuesta'}]);assert.deepEqual(historyAfterRef(h,'FFFFFFFF'),[]);assert.deepEqual(historyAfterRef(h,'<script>'),[]);
});
test('abrir Telegram es navegación, crear factura es un pedido que requiere confirmación',()=>{assert.equal(wantsTelegramChat('abre el chat de Telegram'),true);assert.equal(wantsTelegramChat('crea una factura'),false);assert.equal(requiresTelegram('crea una factura'),true);});
test('apagado y ledger apagado no ofrecen envío; disponibilidad desconocida se rechaza',async()=>{
 for(const motivo of ['sin_vinculo','apagado','entrega_durable_apagada']){
  const c=createPedidosClient({headers,fetcher:async()=>fixture({disponible:false,motivo})});assert.equal((await c.availability()).disponible,false);
 }
 const c=createPedidosClient({headers,fetcher:async()=>fixture({disponible:false,motivo:'otro'})});await assert.rejects(c.availability(),/no válida/);
});
test('errores del contrato conservan código y no repiten peticiones',async()=>{
 for(const [codigo,http] of [['texto_no_permitido',422],['texto_distinto',409],['borrador_caducado',410],['borrador_no_encontrado',404],['recepcion_fallida',503],['demasiados_pedidos',429]]){
  let calls=0;const c=createPedidosClient({headers,fetcher:async()=>{calls++;return fixture({error:'Mensaje del servidor',codigo},false,http);}});
  await assert.rejects(c.confirm(draft),e=>e.codigo===codigo&&e.status===http);assert.equal(calls,1);
 }
});
test('reintento explícito tras pérdida de red confirma el mismo id y hash, sin recrear borrador',async()=>{
 const calls=[];const c=createPedidosClient({headers,fetcher:async(url,options)=>{calls.push({url,body:options.body});if(calls.length===1)throw Error('red perdida');return fixture(status);}});
 await assert.rejects(c.confirm(draft),/red perdida/);await c.confirm(draft);assert.deepEqual(calls[0],calls[1]);assert.ok(calls[0].url.endsWith(`/${id}/confirmar`));
});
test('almacenamiento bloqueado devuelve fallo explícito, no promete recuperación',()=>{
 assert.equal(savePedidoId({setItem:()=>{throw Error('bloqueado');}},'key',id),false);assert.equal(loadPedidoId({getItem:()=>{throw Error('bloqueado');}},'key'),null);
});

test('404 pedido_no_encontrado al consultar olvida la referencia; otros fallos conservan el seguimiento',async()=>{
 const map=new Map();const storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};const key=pedidoStorageKey(headers);
 for(const [codigo,http,forgotten] of [['pedido_no_encontrado',404,true],['borrador_no_encontrado',404,false],['pedido_no_encontrado',503,false],['resultado_incierto',500,false]]){
  savePedidoId(storage,key,id);let calls=0;const c=createPedidosClient({headers,fetcher:async()=>{calls++;return fixture({error:'No hay pedido',codigo},false,http);}});
  try{await c.status(id);assert.fail('Debe fallar');}catch(e){assert.equal(forgetMissingPedido(e,storage,key),forgotten);}
  assert.equal(loadPedidoId(storage,key),forgotten?null:id);assert.equal(calls,1);
 }
});
