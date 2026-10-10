import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilities, validateDestination } from './modules/navegador/capabilities.mjs';
import { AREAS } from './modules/nucleo/organization.mjs';
test('todas las áreas, incluso previstas, son descubribles sin fingir conexión', () => {
  const catalog = buildCapabilities();
  assert.equal(catalog.filter(c=>c.target.kind==='area').length, AREAS.length);
  assert.equal(catalog.find(c=>c.id==='area:processes').status,'planned');
});
test('registrar un subagente añade sus destinos sin modificar el navegador', () => {
  const extra={id:'future',name:'Nueva área',description:'Consulta',stage:'available',modules:[{id:'future_panel',name:'Panel nuevo'}]};
  const catalog=buildCapabilities([...AREAS,extra]);
  assert.equal(validateDestination({capabilityId:'module:future:future_panel',companyId:'EWORKS'},catalog).target.id,'future_panel');
});
test('rechaza destinos inventados, compañías desconocidas y filtros aún no implementados', () => {
  for(const proposal of [null, {capabilityId:'inventado',companyId:'WOBA'},
    {capabilityId:'area:insurance',companyId:'otra'},
    {capabilityId:'area:insurance',companyId:'WOBA',filters:{pendiente:true}},
    {capabilityId:'area:insurance',companyId:'WOBA',section:'pagos'}]) assert.equal(validateDestination(proposal),null);
  assert.equal(validateDestination({capabilityId:'module:insurance:seguros',companyId:'Footprint'}).target.kind,'module');
});

import { findDestinations } from './modules/navegador/resolve.mjs';
test('descubre nombres con acentos y no pretende aplicar filtros ni calcular costes',()=>{
  assert.ok(findDestinations('abre fiscalidad').entries.some(e=>e.target.id==='fiscal'));
  assert.ok(findDestinations('muéstrame seguros').entries.some(e=>e.target.id==='insurance'));
  assert.equal(findDestinations('seguros pendientes').status,'needs_interpretation');
  assert.equal(findDestinations('costos hoy').status,'needs_interpretation');
  assert.equal(findDestinations('seguros eWorks').status,'needs_interpretation');
  assert.equal(findDestinations('xyz inexistente').status,'unknown');
});

test('Seguros registra tres destinos precisos: no se descubren por nombre y su estado lo declara el front (registered hasta implemented)',()=>{
  const catalog=buildCapabilities();
  const secciones=catalog.filter(c=>c.target.kind==='section');
  assert.deepEqual(secciones.map(c=>c.id),['section:insurance:seguros:pagos_pendientes','section:insurance:seguros:proximas_renovaciones','section:insurance:seguros:actividad']);
  for(const c of secciones){ assert.ok(['registered','available'].includes(c.status),`estado de sección desconocido: ${c.status}`); assert.equal(c.target.area,'insurance'); assert.equal(c.target.module,'seguros'); assert.equal(c.companies.length,3); }
  assert.deepEqual(secciones.map(c=>c.scope),['company','company','group']);
  // Compatibilidad: los destinos actuales no cambian y la descubierta local no ofrece secciones.
  assert.equal(catalog.find(c=>c.id==='module:insurance:seguros').status,'available');
  assert.equal(findDestinations('muestrame seguros').entries.some(e=>e.target.kind==='section'),false);
  assert.equal(findDestinations('actividad de wobi seguros').entries.some(e=>e.target.kind==='section'),false);
  const sinImplementar=buildCapabilities(AREAS.map(a=>a.id==='insurance'?{...a,modules:[{...a.modules[0],sections:a.modules[0].sections.map(s=>({...s,implemented:false}))}]}:a));
  assert.ok(sinImplementar.filter(c=>c.target.kind==='section').every(c=>c.status==='registered'),'sin implemented, la sección queda registered');
  assert.equal(validateDestination({capabilityId:'section:insurance:seguros:actividad',companyId:'WOBA'},sinImplementar).status,'registered');
  const implementada=buildCapabilities(AREAS.map(a=>a.id==='insurance'?{...a,modules:[{...a.modules[0],sections:a.modules[0].sections.map(s=>({...s,implemented:true}))}]}:a));
  assert.ok(implementada.filter(c=>c.target.kind==='section').every(c=>c.status==='available'));
});
