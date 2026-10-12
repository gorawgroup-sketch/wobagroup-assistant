import test from 'node:test';
import assert from 'node:assert/strict';
import {operatingCostRequest,operatingCostAnswer,numericRequest} from './modules/navegador/operatingCosts.mjs';
import {financialHelp} from './modules/navegador/financialHelp.mjs';
const sample={controlDiario:{costosDisponibles:true,generadoEn:'2026-10-12T10:00:00Z',costos:{hoy:{gastoRealApiUSD:0.1234,costoUSD:99},ayer:{gastoRealApiUSD:0},semanaActual:{gastoRealApiUSD:2.5},mesActual:{gastoRealApiUSD:5},proyeccionMensualUSD:15,porProcesoHoy:[{proceso:'correo',gastoRealApiUSD:0.1}],porProcesoSemana:[{proceso:'documentos',gastoRealApiUSD:2}]}}};
test('frases reales y separación del gasto contable',()=>{
 for(const q of ['dime cuál es el costo de operación de este sistema','cuánto cuesta operar WOBi','costos de API hoy'])assert.ok(operatingCostRequest(q),q);
 for(const q of ['gastos de Footprint','costos operativos de Footprint','costo de operación de Footprint','costos de hoy','abre seguros','no quiero costos del sistema'])assert.equal(operatingCostRequest(q),false,q);
 assert.ok(numericRequest('costos de hoy'));
 for(const q of ['dime cómo están los estados financieros de footprint','revisa los estados financieros','balance contable de WOBA'])assert.ok(financialHelp(q),q);
});
test('usa gasto real, conserva cero y distingue la proyección y alcance',()=>{
 const a=operatingCostAnswer('costo de operación del sistema',sample);
 assert.ok(a.available);assert.equal(a.rows.length,4);assert.match(a.rows[0].value,/0,1234/);assert.match(a.rows[1].value,/0,0000/);assert.doesNotMatch(a.summary,/99/);assert.match(a.context,/sistema completo/);assert.match(a.limits,/cuotas fijas/);assert.match(a.projection,/15/);
});
test('período y desglose semanal, rechaza períodos históricos no soportados',()=>{
 const a=operatingCostAnswer('gasto semanal de Wobi',sample);assert.equal(a.rows.length,1);assert.equal(a.rows[0].label,'Semana actual');assert.equal(a.breakdown[0].label,'documentos');
 for(const q of ['costos del sistema en septiembre','gasto de Wobi del mes pasado','gasto del sistema de 2025','costo de Wobi mañana','costos del sistema últimos 7 días','costos del sistema en EUR','suscripción de Wobi'])assert.equal(operatingCostAnswer(q,sample).available,false,q);
});
test('fallo y dato mal formado nunca se vuelven cero; lectura conservada visible',()=>{
 assert.equal(operatingCostAnswer('',null).available,false);
 assert.equal(operatingCostAnswer('',{controlDiario:{...sample.controlDiario,costosDisponibles:false}}).available,false);
 const a=operatingCostAnswer('costos del sistema hoy',{...sample,controlDiario:{...sample.controlDiario,costos:{...sample.controlDiario.costos,hoy:{gastoRealApiUSD:null}}}});assert.equal(a.available,false);assert.equal(a.rows[0].value,'No disponible');
 assert.ok(operatingCostAnswer('',{...sample,fuentes:[{fuente:'controlDiario',ok:false,conservado:true}]}).stale);
});
