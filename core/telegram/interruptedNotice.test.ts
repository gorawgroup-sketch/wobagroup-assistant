import test from 'node:test';
import assert from 'node:assert/strict';
import { avisoInterrumpido, claveAviso, decodificarClaveAviso, resumirSolicitudInterrumpida } from './interruptedNotice';
import { crearEntregaTelegram } from './durableDelivery';
const e = crearEntregaTelegram({update_id:1,callback_query:{id:'q',from:{id:7,is_bot:false},data:'gasto_aprobar:p:hash',message:{message_id:3,date:1,chat:{id:7,type:'private'},text:'Bonhomía — Footprint — 213,75 EUR'}}},true);
test('conserva contexto al iniciar sin guardar un update ejecutable',()=>{
 const s=resumirSolicitudInterrumpida(e.payload),c=JSON.parse(s);
 assert.equal(c.accion,'gasto_aprobar:p:hash');assert.match(c.texto,/213,75/);
 assert.equal(c.callback_query,undefined);assert.equal(resumirSolicitudInterrumpida(s),s);
});
test('aviso identifica solicitud y ofrece solo verificar o cerrar',()=>{
 const a=avisoInterrumpido({...e,payload:resumirSolicitudInterrumpida(e.payload)});
 assert.match(a.texto,/Footprint/);assert.match(a.texto,/sin volver a crear/);
 assert.equal(a.botones.length,2);for(const row of a.botones)for(const b of row)assert.ok(Buffer.byteLength(b.callback_data)<=64);
 assert.equal(decodificarClaveAviso(claveAviso(e.clave)),e.clave);
 assert.equal(decodificarClaveAviso('otro'),undefined);
});
test('avisos antiguos sin contexto no se atribuyen a otra operación',()=>{
 assert.match(avisoInterrumpido({...e,payload:''}).texto,/no conservó la operación/);
});

test('continuar correo muestra estado actual sin confundirlo con un resultado financiero', async()=>{
 const {esContinuacionCorreo,avisoEstadoCola}=await import('./interruptedNotice');
 const entrega={...e,payload:JSON.stringify({diagnostico:true,accion:'colacorreo_siguiente',texto:'✅ Resuelto. Quedan 11'})};
 assert.equal(esContinuacionCorreo(entrega),true);
 assert.equal(esContinuacionCorreo(e),false);
 const activo=avisoEstadoCola(entrega,{total:11,activo:{asunto:'Hacienda',pendientesRestantes:2}});
 assert.match(activo.texto,/Hacienda/);assert.doesNotMatch(activo.texto,/✅ Resuelto/);
 assert.ok(!activo.botones.flat().some(b=>b.callback_data==='colacorreo_siguiente'));
 assert.ok(avisoEstadoCola(entrega,{total:10}).botones.flat().some(b=>b.callback_data==='colacorreo_siguiente'));
 assert.ok(!avisoEstadoCola(entrega,{total:0}).botones.flat().some(b=>b.callback_data==='colacorreo_siguiente'));
});
