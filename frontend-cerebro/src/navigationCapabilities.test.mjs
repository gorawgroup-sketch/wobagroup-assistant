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
