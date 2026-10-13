import test from 'node:test';
import assert from 'node:assert/strict';
import {cancelForRevision} from './modules/pedidos/revision.mjs';
const original={pedidoId:'id-original',estado:'pendiente_confirmacion',texto:'dame los gastos de novia'};
test('corregir conserva el texto oído y cancela el original, sin crear ni confirmar solicitudes',async()=>{
 const calls=[];
 const client={cancel:async(id,signal)=>{calls.push(id);return{estado:'cancelado',ejecucion:'no_enviada'};},draft:()=>assert.fail('no debe crear'),confirm:()=>assert.fail('no debe enviar')};
 const result=await cancelForRevision(client,original,new AbortController().signal);
 assert.deepEqual(calls,['id-original']);assert.equal(result.texto,'dame los gastos de novia');assert.equal(result.cancelled.estado,'cancelado');
});
test('sin cancelación confirmada no se devuelve el texto para un borrador nuevo',async()=>{
 for(const result of [{estado:'procesando',ejecucion:'en_curso'},{estado:'cancelado',ejecucion:'pendiente'}]){
  await assert.rejects(cancelForRevision({cancel:async()=>result},original),/confirmar la cancelación/);
 }
 await assert.rejects(cancelForRevision({cancel:async()=>{throw Error('red');}},original),/red/);
 let calls=0;await assert.rejects(cancelForRevision({cancel:async()=>{calls++;}},{...original,estado:'recibido'}),/estado/);assert.equal(calls,0);
});
test('un borrador caducado y sin enviar también permite corregirlo',async()=>{
 const result=await cancelForRevision({cancel:async()=>({estado:'expirado',ejecucion:'no_enviada'})},original);
 assert.equal(result.texto,original.texto);
});
