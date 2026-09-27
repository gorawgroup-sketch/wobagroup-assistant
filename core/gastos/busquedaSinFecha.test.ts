import test from 'node:test';import assert from 'node:assert/strict';
import {seleccionarFechaBancaria,type CandidatoSinFecha} from './busquedaSinFecha';
const cargo:CandidatoSinFecha={accountId:'a',movementId:'1',descripcion:'Bolt',monto:-12,moneda:'EUR',fecha:'2026-09-10',status:'pending'};
test('sin fecha se investiga el cargo único incluso si ya está conciliado, sin elegir entre varios',()=>{
 assert.equal(seleccionarFechaBancaria([cargo]),'2026-09-10');
 assert.equal(seleccionarFechaBancaria([{...cargo,status:'reconciled'}]),'2026-09-10');
 assert.equal(seleccionarFechaBancaria([]),undefined);
 assert.equal(seleccionarFechaBancaria([cargo,{...cargo,movementId:'2'}]),undefined);
});
