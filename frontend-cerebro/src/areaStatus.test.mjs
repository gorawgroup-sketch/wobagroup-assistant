import test from 'node:test';
import assert from 'node:assert/strict';
import { areaStatus } from './modules/nucleo/areaStatus.mjs';
import { areaById } from './modules/nucleo/organization.mjs';
test('Procesos reserva el futuro agente sin declarar herramientas conectadas', () => {
  const procesos=areaById('processes');
  assert.equal(procesos.stage,'planned');
  assert.deepEqual(procesos.modules,[]);
  assert.equal(areaStatus(procesos,{fuentes:[{fuente:'drive',ok:true}]}).id,'planned');
});
test('el estado visual no confunde una fuente ausente o fallida con una conexión verificada', () => {
  const seguros=areaById('insurance');
  assert.equal(areaStatus(seguros,null).id,'checking');
  assert.equal(areaStatus(seguros,{fuentes:[]}).id,'checking');
  assert.equal(areaStatus(seguros,{fuentes:[{fuente:'seguros',ok:true}]}).id,'available');
  assert.equal(areaStatus(seguros,{fuentes:[{fuente:'seguros',ok:true},{fuente:'seguros.documentos',ok:false}]}).id,'incident');
});
test('cada herramienta requiere constancia de lectura; calendario usa la fuente crm', () => {
  const operaciones=areaById('operations');
  const fuentes=['drive','correo','conocimiento','crm'].map(fuente=>({fuente,ok:true}));
  assert.equal(areaStatus(operaciones,{fuentes}).id,'available');
  assert.equal(areaStatus(operaciones,{fuentes:fuentes.slice(0,3)}).id,'checking');
  assert.equal(areaStatus(areaById('corporate'),{fuentes:[{fuente:'drive',ok:true}]}).id,'documents');
});
