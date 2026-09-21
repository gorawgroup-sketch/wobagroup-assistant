import assert from 'node:assert/strict';
import test from 'node:test';
import { posponerCorreoActivoYContinuar, type DependenciasPosponerCorreo } from './posponerCorreoActivo';
import type { ItemColaCorreo } from './colaRevisionStore';
const activo: ItemColaCorreo = {id:'thread',mensajeId:'mail',chatId:1,de:'a',asunto:'pendiente',fechaOrden:1,estado:'activo',pendientesRestantes:1,agregadoEn:1,accionesResueltas:[]};
function escenario() {
  const acciones: string[]=[];
  const d: DependenciasPosponerCorreo = {
    coordinar: async f=>{acciones.push('lock');return f();}, activo:async()=>activo,
    retirar:async(chat,id)=>{assert.equal(chat,1);assert.deepEqual(id,{threadId:'thread',mensajeId:'mail'});acciones.push('retirar');return true;},
    avisar:async()=>{acciones.push('avisar');}, siguiente:async()=>{acciones.push('siguiente');},
  };return {d,acciones};
}
test('aplazar libera solo la identidad activa y procesa el siguiente bajo el mismo coordinador', async()=>{
  const e=escenario();const result=await posponerCorreoActivoYContinuar(1,undefined,e.d);
  assert.match(result,/sin marcarlo leído/);assert.deepEqual(e.acciones,['lock','retirar','avisar','siguiente']);
  assert.equal(activo.pendientesRestantes,1);assert.deepEqual(activo.accionesResueltas,[]);
});
test('un botón antiguo no aplaza ni procesa el correo siguiente',async()=>{
  const e=escenario();await posponerCorreoActivoYContinuar(1,{threadId:'otro',mensajeId:'otro'},e.d);
  assert.deepEqual(e.acciones,['lock']);
});
test('si no puede liberar no avanza',async()=>{
  const e=escenario();e.d.retirar=async()=>false;
  assert.match(await posponerCorreoActivoYContinuar(1,undefined,e.d),/No pude liberar/);assert.deepEqual(e.acciones,['lock']);
});
test('sin activo la orden textual procesa el siguiente, un botón repetido no lo hace',async()=>{
  const e=escenario();e.d.activo=async()=>undefined;await posponerCorreoActivoYContinuar(1,undefined,e.d);
  assert.deepEqual(e.acciones,['lock','siguiente']);e.acciones.length=0;
  await posponerCorreoActivoYContinuar(1,{threadId:'thread',mensajeId:'mail'},e.d);assert.deepEqual(e.acciones,['lock']);
});
