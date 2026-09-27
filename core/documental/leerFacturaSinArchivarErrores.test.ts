import test from 'node:test';import assert from 'node:assert/strict';
import {leerFacturaSinArchivarErrores}from'./leerFacturaSinArchivarErrores';
test('quota or budget failure never reaches generic archive or retries immediately',async()=>{
 for(const error of [Object.assign(new Error('quota'),{response:{status:429}}),new Error('Presupuesto agotado')]){
  let calls=0,archived=false;
  await assert.rejects(async()=>{const r=await leerFacturaSinArchivarErrores(async()=>{calls++;throw error});if(!r)archived=true;},e=>e===error);
  assert.equal(calls,1);assert.equal(archived,false);
 }
});
test('persistent read failure propagates instead of reporting not-an-expense',async()=>{
 let calls=0;await assert.rejects(leerFacturaSinArchivarErrores(async()=>{calls++;throw Error('network');}),/network/);assert.equal(calls,2);
});
test('transient failure can recover the expense and real negative classification stays negative',async()=>{
 let calls=0;const result={esFacturaOGasto:true};assert.equal(await leerFacturaSinArchivarErrores(async()=>{if(++calls===1)throw Error('temporary');return result}),result);
 assert.deepEqual(await leerFacturaSinArchivarErrores(async()=>({esFacturaOGasto:false})),{esFacturaOGasto:false});
});
