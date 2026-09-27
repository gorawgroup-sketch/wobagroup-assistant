import test from 'node:test';import assert from 'node:assert/strict';
import{gastoRecurrenteIndependiente}from'./gastoRecurrente';
import{movimientoCompatibleConGasto,proveedorPareceEnDescripcion}from'./write';
const actual={numeroDocumento:'NEW123',fecha:'2026-08-25'};
const anterior={document_number:'OLD456',date:'2026-08-24',payments_pending:'0,00',payments_detail:[{date:'2026-08-24'}]};
test('another dated receipt and paid purchase may be independent when a separate free bank charge is verified',()=>{
 assert.equal(gastoRecurrenteIndependiente(actual,anterior),true);
 for(const cambios of [{document_number:'NEW123'},{document_number:'00000'},{date:actual.fecha},{payments_pending:'3,98'},{payments_detail:[]},{payments_detail:[{date:actual.fecha}]}])assert.equal(gastoRecurrenteIndependiente(actual,{...anterior,...cambios}),false);
});
test('hotel merchant descriptor can pay a standalone meal, but not an unrelated restaurant or taxi',()=>{
 assert.equal(proveedorPareceEnDescripcion('HOTEL EXAMPLE','Acquirer*hotel ex'),true);
 assert.equal(movimientoCompatibleConGasto('HOTEL EXAMPLE','Desayuno en Hotel Example','Acquirer*hotel ex'),true);
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto','Acquirer*hotel ex'),false);
 assert.equal(proveedorPareceEnDescripcion('HOTEL EXAMPLE','Acquirer*hotel'),false);
});
