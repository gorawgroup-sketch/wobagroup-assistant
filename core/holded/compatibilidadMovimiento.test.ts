import test from 'node:test';
import assert from 'node:assert/strict';
import {movimientoCompatibleConGasto, inferirTagsCategoria, combinarTagsGastoAprendidos, nivelCompatibilidadMovimiento, candidatoUtilizableParaGasto, proveedorPareceEnDescripcion} from './write';
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

const CONCEPTO_CAFE = 'Café — JUST B CUZ PLM, San Juan, Puerto Rico — Simon Talloen — pagado con Revolut (comprobante visual generado desde el cuerpo del correo, sin adjunto original)';

test('caso real 2026-09-28: «JUST B CUZ PLM» y «Par*just B Cuz Luxury» comparten el núcleo de marca', () => {
  assert.equal(proveedorPareceEnDescripcion('JUST B CUZ PLM', 'Par*just B Cuz Luxury'), true);
  assert.equal(movimientoCompatibleConGasto('JUST B CUZ PLM', CONCEPTO_CAFE, 'Par*just B Cuz Luxury'), true);
  // Un solo término compartido, o palabras genéricas, no bastan.
  assert.equal(proveedorPareceEnDescripcion('Cafe Central', 'Cafe Mayor'), false);
  assert.equal(proveedorPareceEnDescripcion('Just Eat', 'Sq *Just Paid'), false);
});

test('nivel «por_confirmar»: categoría desconocida + importe, moneda y fecha exactos; nunca con categorías contradictorias', () => {
  const evidencia = { importeYFechaExactos: true };
  assert.equal(nivelCompatibilidadMovimiento('Mi Cafetería', 'Café', 'SQ *XYZ 88', evidencia), 'por_confirmar');
  // Sin la evidencia de importe y fecha, un nombre irreconocible sigue siendo incompatible.
  assert.equal(nivelCompatibilidadMovimiento('Mi Cafetería', 'Café', 'SQ *XYZ 88'), 'incompatible');
  // Categorías contradictorias impiden la asociación incluso con importe y fecha exactos (política #204).
  assert.equal(nivelCompatibilidadMovimiento('Bolt', 'Taxi aeropuerto', 'Osteria Del Lovo', evidencia), 'incompatible');
  assert.equal(nivelCompatibilidadMovimiento('Uber', 'Traslado taxi', 'Uber Eats', evidencia), 'incompatible');
  // Sin descripción no hay nada que confirmar.
  assert.equal(nivelCompatibilidadMovimiento('Mi Cafetería', 'Café', '', evidencia), 'incompatible');
  // Lo ya compatible por nombre no necesita evidencia adicional.
  assert.equal(nivelCompatibilidadMovimiento('Bolt', 'Taxi aeropuerto', 'Bolt.eu/o/2610011234'), 'compatible');
});

test('un candidato marcado por_confirmar es utilizable; uno sin marca depende de nombre/categoría', () => {
  assert.equal(candidatoUtilizableParaGasto('Mi Cafetería', 'Café', { descripcion: 'SQ *XYZ 88', compatibilidad: 'por_confirmar' }), true);
  assert.equal(candidatoUtilizableParaGasto('Mi Cafetería', 'Café', { descripcion: 'SQ *XYZ 88' }), false);
  assert.equal(candidatoUtilizableParaGasto('Bolt', 'Taxi', { descripcion: 'Bolt.eu/o/1' }), true);
});
