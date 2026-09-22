import test from 'node:test';
import assert from 'node:assert/strict';
import {handleCallbackQuery} from './callbackHandler';
import type {TelegramCallbackQuery} from './types';

test('abrir áreas conserva la propuesta y no consume ni registra el movimiento',async()=>{
 let consumed=0;const edits:unknown[][]=[];
 const deps={ obtenerPropuesta:async()=>({id:'p1',empresa:'WOBA',bloqueSugerido:'gastos_fijos',clienteOConcepto:'Proveedor',semana:'S38',valor:10,chatId:12,messageId:9,creadoEn:Date.now()} as const),
 consumirPropuesta:async()=>{consumed++;throw Error('No debe consumir');},
 answerCallbackQuerySafe:async()=>{},
 editTelegramMessage:async(...args:unknown[])=>{edits.push(args);} };
 await handleCallbackQuery({id:'cb',data:'cf_area:p1',message:{message_id:9,chat:{id:12}}} as TelegramCallbackQuery,deps);
 assert.equal(consumed,0);assert.equal(edits.length,1);
 assert.ok(JSON.stringify(edits[0]).includes('cf_approve:p1:pagos_extras'));
 await handleCallbackQuery({id:'cb2',data:'cf_area:p1',message:{message_id:9,chat:{id:13}}} as TelegramCallbackQuery,deps);
 assert.equal(edits.length,1);assert.equal(consumed,0);
});
