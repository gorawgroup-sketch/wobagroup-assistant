import test from 'node:test';
import assert from 'node:assert/strict';
import { ajustarCompraAlMovimientoElegido } from './ajustarCompraAlMovimiento';
function escenario(total='5,65', amount='-5.97') {
 const calls: unknown[][]=[];
 const compra={total,currency:'EUR',payments_total:'0,00',payments_detail:[] as unknown[]};
 const movimiento={status:'pending',reconciled_amount:'0.00',currency:'EUR',amount};
 const elegido={accountId:'a',movementId:'m',fecha:'2026-09-16',monto:Number(amount),moneda:'EUR',descripcion:'Payu*uber'};
 const deps={leerCompra:async()=>compra,leerMovimiento:async()=>movimiento,editar:async(...args:unknown[])=>{calls.push(args);}};
 return {compra,movimiento,elegido,calls,deps:deps as any};
}
for(const [total,amount] of [['5,65','-5.97'],['6.20','-5.97']]) test(`ajusta ${total} a cargo elegido ${amount} con edición durable`,async()=>{
 const e=escenario(total,amount);await ajustarCompraAlMovimientoElegido('Footprint','g',e.elegido,e.deps);
 assert.deepEqual(e.calls[0][2],{montoNuevo:5.97});assert.match(JSON.stringify(e.calls[0][3]),/ajuste-movimiento:g:m:597/);
});
test('un reintento con el importe ya ajustado no vuelve a editar',async()=>{
 const e=escenario('5.97');await ajustarCompraAlMovimientoElegido('Footprint','g',e.elegido,e.deps);assert.equal(e.calls.length,0);
});
test('rechaza pagos previos, movimientos ocupados, cargo cambiado y diferencias grandes',async()=>{
 for(const change of [(e:any)=>e.compra.payments_detail.push({amount:'1'}),(e:any)=>e.movimiento.status='reconciled',(e:any)=>e.movimiento.amount='-5.98',(e:any)=>e.compra.total='100']) {
  const e=escenario();change(e);await assert.rejects(ajustarCompraAlMovimientoElegido('Footprint','g',e.elegido,e.deps));assert.equal(e.calls.length,0);
 }
});
test('no sustituye el importe nativo por otra divisa',async()=>{
 const e=escenario();e.compra.currency='COP';await ajustarCompraAlMovimientoElegido('Footprint','g',e.elegido,e.deps);assert.equal(e.calls.length,0);
});
