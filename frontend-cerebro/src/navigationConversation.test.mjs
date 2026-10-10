import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationReply} from './modules/navegador/conversation.mjs';
test('cortesía y ayuda con acentos y puntuación',()=>{
 for(const text of ['Hola, ¿cómo estás?','Wobi hola','¿Qué puedes encontrar?','Puedes encontrar algo para mí','ayuda','Gracias']) assert.ok(conversationReply(text),text);
});
test('nunca absorbe una orden ni una pregunta sobre datos',()=>{
 for(const text of ['hola abre seguros','ayuda con seguros pendientes','cuánto gastamos hoy','abre finanzas','hola borra datos',null]) assert.equal(conversationReply(text),null,text);
});
