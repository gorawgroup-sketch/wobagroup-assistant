import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretNavigation } from './modules/navegador/client.mjs';
import { buildCapabilities } from './modules/navegador/capabilities.mjs';
import { validateConversationResponse, readingDate } from './modules/navegador/response.mjs';
const catalog={version:'nav-1',companias:['WOBA','EWORKS','Footprint'],capacidades:buildCapabilities().map(c=>({...c,acceso:'permitido'})),conversacional:{disponible:true}};
const lectura={tipo:'seguros_pagos_pendientes',empresa:'WOBA',estado:'completa',leidoEn:'2026-10-11T08:00:00Z',generadoEn:'2026-10-11T08:05:00Z',refrescando:false,fuentes:[],avisos:[],total:0,mostrados:0,items:[]};
const response={tipo:'destino',capabilityId:'section:insurance:seguros:pagos_pendientes',companyId:'WOBA',requestId:'request-123',catalogVersion:'nav-1',avisos:[],modo:'deterministico',conversacionId:'opaque-server-id',resumen:'No hay pagos pendientes en la lectura de WOBA.',lectura};
const invoke=(r,options={})=>{const calls=[];let n=0;const conversation={current:{id:'previous-id'}};return {calls,conversation,promise:interpretNavigation({texto:'seguros',companyId:'WOBA',requestId:'request-123'},{headers:{},conversation,fetcher:async(url,opt)=>{calls.push({url,body:opt.body&&JSON.parse(opt.body)});return{ok:true,json:async()=>n++===0?catalog:r};},...options})};};
test('usa conversar y reenvía exclusivamente el id opaco; lo conserva tras validar',async()=>{
 const x=invoke(response);await x.promise;assert.match(x.calls[1].url,/conversar$/);assert.equal(x.calls[1].body.conversacionId,'previous-id');assert.deepEqual(Object.keys(x.calls[1].body).sort(),['companyId','conversacionId','requestId','texto']);assert.equal(x.conversation.current.id,'opaque-server-id');
});
test('catálogo anterior mantiene interpretar y no envía contexto',async()=>{
 let n=0;let body,url;const legacy={...response};delete legacy.lectura;delete legacy.modo;delete legacy.resumen;delete legacy.conversacionId;
 await interpretNavigation({texto:'seguros',companyId:'WOBA',requestId:'request-123'},{headers:{},conversation:{current:{id:'old'}},fetcher:async(u,o)=>{if(o.body){body=JSON.parse(o.body);url=u;}return{ok:true,json:async()=>n++===0?{...catalog,conversacional:{disponible:false}}:legacy};}});assert.match(url,/interpretar$/);assert.equal(body.conversacionId,undefined);
});
test('no degrada un fallo de conversar a inferencia o al endpoint anterior',async()=>{
 let n=0;const x=invoke(response,{fetcher:async()=>n++===0?{ok:true,json:async()=>catalog}:{ok:false,status:503}});await assert.rejects(x.promise,/503/);assert.equal(n,2);assert.equal(x.conversation.current.id,'previous-id');
});
test('distingue cero completo, lectura anterior sin total y fuente no consultable sin resultados',()=>{
 assert.ok(validateConversationResponse(response,catalog.companias));
 const partial={...lectura,estado:'incompleta',total:undefined};assert.ok(validateConversationResponse({...response,lectura:partial},catalog.companias));assert.equal(validateConversationResponse({...response,lectura:{...partial,total:0}},catalog.companias),false);
 const missing={...lectura,estado:'no_consultable',items:undefined,total:undefined,mostrados:undefined};assert.ok(validateConversationResponse({...response,tipo:'no_disponible',lectura:missing},catalog.companias));assert.equal(validateConversationResponse({...response,tipo:'no_disponible',lectura:{...missing,items:[]}},catalog.companias),false);
});
test('rechaza datos de otra compañía, lectura de otra sección e ids mal formados',async()=>{
 for(const r of [{...response,lectura:{...lectura,empresa:'Footprint'}},{...response,lectura:{...lectura,tipo:'seguros_actividad',empresa:null}},{...response,conversacionId:null},{...response,resumen:''},{...response,lectura:{...lectura,fuentes:[null]}}]){const x=invoke(r);await assert.rejects(x.promise);assert.equal(x.conversation.current.id,'previous-id');}
});
test('petición cancelada nunca sustituye el contexto de la sesión',async()=>{
 const controller=new AbortController();controller.abort();const x=invoke(response,{signal:controller.signal});await assert.rejects(x.promise);assert.equal(x.conversation.current.id,'previous-id');
});
test('fecha de Madrid y ausencia de fecha no se sustituyen por ahora',()=>{
 assert.match(readingDate('2026-10-11T08:00:00Z'),/10:00:00/);assert.equal(readingDate(null),'Sin fecha de lectura verificada');
});
