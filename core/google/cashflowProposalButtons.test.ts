import test from 'node:test';
import assert from 'node:assert/strict';
import {botonesAreasCashflow,esCambioDivisaCashflow} from './cashflowProposalButtons';
import {rangoPedido} from '../tools/compararCashflowHolded';
import {proponerRegistroCashflowTool} from '../tools/proponerRegistroCashflow';

test('áreas alternativas usan callbacks existentes y caben en Telegram',()=>{
 const rows=botonesAreasCashflow('12345678');const buttons=rows.flat();
 assert.ok(buttons.some(b=>b.callback_data==='cf_approve:12345678:pagos_pendientes_alberto'));
 assert.ok(buttons.some(b=>b.callback_data==='cf_reject:12345678'));
 assert.ok(buttons.every(b=>Buffer.byteLength(b.callback_data)<=64));
 assert.ok(buttons.every(b=>!b.callback_data.includes('impuestos')));
 assert.equal(new Set(buttons.map(b=>b.callback_data)).size,buttons.length);
});
test('propuesta conserva la semana explícita por encima del periodo',()=>{
 const r=rangoPedido({semana:'S38',periodo:'semana_actual'});assert.ok(!('error' in r));
 assert.equal(r.semana,'S38');assert.equal(new Date(r.desde+'T12:00:00Z').getUTCDay(),1);
 assert.equal((Date.parse(r.hasta)-Date.parse(r.desde))/86400000,6);
 assert.ok(Object.hasOwn(proponerRegistroCashflowTool.input_schema.properties ?? {}, 'semana'));
 assert.ok('error' in rangoPedido({semana:'S99'}));
});
test('una conversión bancaria no se presenta como un gasto ordinario',()=>{
 assert.equal(esCambioDivisaCashflow('Exchanged To Eur Main Euros'),true);
 assert.equal(esCambioDivisaCashflow('Converted USD to EUR'),true);
 assert.equal(esCambioDivisaCashflow('Holded Technologies SL'),false);
});
