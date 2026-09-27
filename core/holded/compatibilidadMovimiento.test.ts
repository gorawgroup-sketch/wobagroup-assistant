import test from 'node:test';
import assert from 'node:assert/strict';
import {movimientoCompatibleConGasto, inferirTagsCategoria, combinarTagsGastoAprendidos} from './write';
test('el importe exacto no permite cruzar proveedor ni categoría',()=>{
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto','Osteria Del Lovo'),false);
 assert.equal(movimientoCompatibleConGasto('Uber','Traslado taxi','Uber Eats'),false);
 assert.equal(movimientoCompatibleConGasto('Uber Eats','Comida','Uber trip'),false);
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto','Bolt.eu/o/2610011234'),true);
 assert.equal(movimientoCompatibleConGasto('UBER COLOMBIA','Traslado taxi','Payu*uber'),true);
 assert.equal(movimientoCompatibleConGasto('Uber Eats','Comida','UBER EATS'),true);
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto',''),false);
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto','Cabify Madrid'),true);
 assert.equal(movimientoCompatibleConGasto('Restaurante A','Comida','Restaurante B'),true);
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto','Hotel Orly'),false);
});

test('un desayuno independiente no hereda hospedaje del hotel', () => {
  assert.deepEqual(inferirTagsCategoria('Desayuno en Hotel Central', 'Hotel Central'), ['alimentacion']);
  assert.deepEqual(inferirTagsCategoria('Hospedaje con desayuno incluido', 'Hotel Central'), ['hospedaje']);
  assert.deepEqual(combinarTagsGastoAprendidos('Desayuno — Alejandro Florez', 'Hotel Central', undefined, ['kelly','hospedaje']), ['alejandroflorez','alimentacion']);
});
