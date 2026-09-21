import assert from 'node:assert/strict';
import test from 'node:test';
import { tasaCambioParaEdicion, type CompraHoldedCruda } from './write';
const compra = (extra: Partial<CompraHoldedCruda> = {}): CompraHoldedCruda => ({id:'airbnb',currency:'USD',currency_change:'1.15',total:'233,21',payments_total:'233,21',payments_pending:'0,00',payments_detail:[{id:'banco',amount:'203,03'},{id:'ajuste',amount:'0,47'}],...extra});
test('editar clasificación no convierte el saldo cero de Airbnb en un sobrepago de 0,82 USD',()=>{
  assert.equal(Math.round(20350 * 115 / 100)-23321,82);
  const tasa=tasaCambioParaEdicion(compra());
  assert.equal(Math.round(203.50*tasa*100),23321);
  assert.equal(Math.round(tasa*100),115);
});
test('conserva el saldo de pagos parciales sin inventar un tipo de cambio de mercado',()=>{
  const tasa=tasaCambioParaEdicion(compra({total:'333,21',payments_pending:'100,00'}));
  assert.equal(Math.round((333.21-203.50*tasa)*100),10000);
});
test('no reconstruye ni altera una tasa que Holded ya entrega con precisión',()=>{
  assert.equal(tasaCambioParaEdicion(compra({currency_change:'1.148649'})),1.148649);
});
test('una compra sin pagos conserva su tasa',()=>{
  assert.equal(tasaCambioParaEdicion(compra({payments_detail:[],payments_total:'0,00',payments_pending:'233,21'})),1.15);
});
test('rechaza datos incoherentes y devoluciones antes del PUT',()=>{
  for(const extra of [{payments_total:undefined},{payments_pending:undefined},{payments_total:'10,00'},{payments_refunds:'2,00'},{payments_detail:[{id:'x',amount:'0,00'}]}])assert.throws(()=>tasaCambioParaEdicion(compra(extra)),/preservar el cambio/);
});
