import test from 'node:test';
import assert from 'node:assert/strict';
import { systemAttention } from './modules/nucleo/attention.mjs';

test('no convierte una lectura ausente o fallida en cero pendientes', () => {
  assert.ok(systemAttention(null).every(item => item.value === null));
  const data = { cashflow: { propuestasPendientes: [] }, fuentes: [{ fuente: 'cashflow.propuestas', ok: false, conservado: true }] };
  assert.equal(systemAttention(data)[0].value, null);
  data.fuentes = [{ fuente: 'cashflow', ok: false }];
  assert.equal(systemAttention(data)[0].value, null);
});
test('cero confirmado se distingue de ausencia, sin inventar un filtro de compañía', () => {
  const data = { cashflow: { propuestasPendientes: [] }, correo: { borradoresPendientesDeAprobacion: 2 }, holded: { gastosSinComprobante: null, movimientosSinConciliar: 4 } };
  assert.deepEqual(systemAttention(data).map(item => item.value), [0, 2, null, 4]);
});
