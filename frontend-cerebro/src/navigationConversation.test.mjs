import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationReply} from './modules/navegador/conversation.mjs';
test('cortesía y ayuda con acentos y puntuación',()=>{
 for(const text of ['Hola, ¿cómo estás?','Wobi hola','Hola Wobi','hola Guapi','Hola Woby','¿cómo estás Guapi?','Hola Wobi cómo estás','Hola, Wobby, qué tal','¿Wobi estás ahí?','¿Quién eres Wobi?','¿Qué puedes encontrar?','Puedes encontrar algo para mí','Wobi puedes ayudarme','ayuda','Gracias Wobi','me puedes ayudar con algo','¿Wobi, podrías ayudarme con algo?','puedes ayudarme a encontrar algo para mí','ayúdame con algo','necesito que me ayudes','qué sabes hacer','te puedes presentar hay alguien que te quiere conocer','preséntate Wobi','puedes presentarte']) assert.ok(conversationReply(text),text);
});
test('nunca absorbe una orden ni una pregunta sobre datos',()=>{
 for(const text of ['hola abre seguros','ayuda con seguros pendientes','cuánto gastamos hoy','abre finanzas','hola borra datos','me puedes ayudar con seguros','puedes ayudarme con los costos de hoy','ayúdame a abrir finanzas','preséntate y abre finanzas','dame los últimos costos o los costos de hoy',null]) assert.equal(conversationReply(text),null,text);
});

test('presentación en primera persona identifica empresas y alcance actual',()=>{
 const reply=conversationReply('sí preséntate Wobi');
 for(const expected of ['soy WOBi','WOBA','eWorks','Footprint Global','Seguros','permisos','Telegram'])assert.ok(reply.includes(expected),expected);
 assert.equal(conversationReply('sí'),null); // Sigue siendo una selección del servidor, no una presentación.
});
