import test from 'node:test';
import assert from 'node:assert/strict';
import { obtenerContactoSinIdentificar } from './contactoSinIdentificar';
import type { holdedGet } from '../holded/client';
import type { crearContactoHolded } from '../holded/write';
const noCrear = (async()=>{throw Error('No debe crear');}) as typeof crearContactoHolded;
test('ignora el antiguo ID renombrado Lidl y reutiliza el genérico real', async()=>{
 const generic={id:'generic',name:'Sin identificar (ticket sin nombre de establecimiento visible)'};
 const get=(async(_e:unknown,p:string)=>p==='/contacts'?{items:[{id:'old',name:'Lidl Breda'},generic],has_more:false}:generic) as typeof holdedGet;
 assert.equal((await obtenerContactoSinIdentificar('Footprint',get,noCrear)).id,'generic');
});
test('rechaza contacto renombrado después de listar',async()=>{
 const get=(async(_e:unknown,p:string)=>p==='/contacts'?{items:[{id:'old',name:'PROVEEDOR SIN IDENTIFICAR'}],has_more:false}:{id:'old',name:'Lidl Breda'}) as typeof holdedGet;
 await assert.rejects(obtenerContactoSinIdentificar('Footprint',get,noCrear),/cambió de identidad/);
});
test('no elige entre varios genéricos',async()=>{
 const get=(async()=>({items:[{id:'a',name:'PROVEEDOR SIN IDENTIFICAR'},{id:'b',name:'PROVEEDOR SIN IDENTIFICAR'}],has_more:false})) as typeof holdedGet;
 await assert.rejects(obtenerContactoSinIdentificar('Footprint',get,noCrear),/varios contactos/);
});
