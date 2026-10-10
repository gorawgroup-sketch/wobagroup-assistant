import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { segurosDestination } from './modules/seguros/destinations.mjs';
const fixture=JSON.parse(readFileSync(new URL('../../docs/ejemplos/estado-seguros.json',import.meta.url)));
test('pagos pendientes separan las tres compañías sin inferir pagos desde pólizas',()=>{
 assert.equal(segurosDestination(fixture,'pagos_pendientes','WOBA').items.length,1);
 for(const company of ['EWORKS','Footprint'])assert.deepEqual(segurosDestination(fixture,'pagos_pendientes',company).items,[]);
 assert.equal(segurosDestination({...fixture,pagosSinConfirmar:null},'pagos_pendientes','WOBA').items,null);
 assert.equal(segurosDestination(null,'pagos_pendientes','WOBA').items,null);
});
test('renovaciones no incluyen pagos, deduplican alerta y horizonte y conservan hoy',()=>{
 const source={...fixture,proximasARenovar:[{id:'one',empresa:'WOBA',fechaVencimiento:'2026-10-10',diasRestantes:0,tipoCobertura:'RC'}],proximos:[{polizaId:'one',empresa:'WOBA',fecha:'2026-10-10',diasRestantes:0,tipo:'vencimiento'},{polizaId:'one',empresa:'WOBA',fecha:'2026-10-11',tipo:'pago'}]};
 const view=segurosDestination(source,'proximas_renovaciones','WOBA');assert.equal(view.items.length,1);assert.equal(view.items[0].diasRestantes,0);assert.equal(view.items[0].urgent,true);
 for(const company of ['WOBA','EWORKS','Footprint'])assert.ok(segurosDestination(fixture,'proximas_renovaciones',company).items.every(e=>e.empresa===company&&e.tipo!=='pago'));
 const unavailable=segurosDestination({proximasARenovar:null,proximos:null},'proximas_renovaciones','WOBA');assert.equal(unavailable.items,null);
 const partial=segurosDestination({proximasARenovar:[],proximos:null},'proximas_renovaciones','WOBA');assert.equal(partial.upcomingAvailable,false);
});
test('actividad mantiene todo el grupo y distingue null de una bitácora vacía',()=>{
 for(const company of ['WOBA','EWORKS','Footprint']){const view=segurosDestination(fixture,'actividad',company);assert.equal(view.scope,'group');assert.equal(view.activity.bitacora,fixture.bitacora);}
 assert.equal(segurosDestination(null,'actividad','WOBA').activity.bitacora,null);
 assert.deepEqual(segurosDestination({bitacora:[]},'actividad','EWORKS').activity.bitacora,[]);
 assert.equal(segurosDestination(fixture,'inventada','WOBA'),null);assert.equal(segurosDestination(fixture,'actividad','otra'),null);
});
