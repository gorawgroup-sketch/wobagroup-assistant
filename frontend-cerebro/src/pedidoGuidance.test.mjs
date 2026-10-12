import test from 'node:test';
import assert from 'node:assert/strict';
import {pedidoGuidance} from './modules/pedidos/guidance.mjs';
test('orientación hablada distingue recepción, procesamiento y resultado incierto',()=>{
 assert.match(pedidoGuidance({estado:'recibido'}),/recibió/);
 assert.match(pedidoGuidance({estado:'procesando'}),/procesando/);
 assert.match(pedidoGuidance({estado:'fallido'}),/No pude verificar/);
 assert.doesNotMatch(pedidoGuidance({estado:'fallido'}),/recibió|terminó/);
 assert.match(pedidoGuidance({estado:'expirado'}),/sin enviarse/);
});
