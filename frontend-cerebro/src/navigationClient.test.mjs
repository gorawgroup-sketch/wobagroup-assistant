import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretNavigation } from './modules/navegador/client.mjs';
import { buildCapabilities } from './modules/navegador/capabilities.mjs';
const catalog={version:'nav-1',companias:['WOBA','EWORKS','Footprint'],capacidades:buildCapabilities().map(c=>({...c,acceso:'permitido'}))};
const destination={tipo:'destino',requestId:'req-123456',catalogVersion:'nav-1',capabilityId:'module:insurance:seguros',companyId:'EWORKS',avisos:[]};
const invoke=(result,extra={})=>{let n=0;return interpretNavigation({texto:'seguros',companyId:'WOBA',requestId:'req-123456'},{headers:{'X-Cerebro-Key':'demo'},fetcher:async()=>({ok:true,json:async()=>n++===0?catalog:result}),...extra});};
test('valida destino y compañía del servidor sin URL ni selección DOM',async()=>{
 const result=await invoke(destination);assert.equal(result.companyId,'EWORKS');
});
test('rechaza destino inventado, request distinto y acceso prohibido',async()=>{
 await assert.rejects(invoke({...destination,capabilityId:'inventado'}));
 await assert.rejects(invoke({...destination,requestId:'otra'}));
 let n=0;await assert.rejects(invoke(destination,{fetcher:async()=>({ok:true,json:async()=>n++===0?{...catalog,capacidades:catalog.capacidades.map(c=>({...c,acceso:'permiso_insuficiente'}))}:destination})}));
});
test('conserva aclaración sin filtro y error de fuente como variantes distintas',async()=>{
 const clarification={tipo:'aclaracion',requestId:'req-123456',catalogVersion:'nav-1',pregunta:'¿Abrir sin filtro?',opciones:[{capabilityId:destination.capabilityId,companyId:'WOBA',etiqueta:'Seguros',sinFiltro:true}]};
 assert.equal((await invoke(clarification)).opciones[0].sinFiltro,true);
 assert.equal((await invoke({tipo:'no_disponible',requestId:'req-123456',catalogVersion:'nav-1',motivo:'fuente_no_consultable',mensaje:'Sin fuente propia'})).motivo,'fuente_no_consultable');
});
test('cambio de versión exige catálogo actualizado y fallo HTTP nunca produce destino',async()=>{
 await assert.rejects(invoke({...destination,catalogVersion:'nav-2'}));
 await assert.rejects(invoke(destination,{fetcher:async()=>({ok:false,status:503})}),/503/);
});
