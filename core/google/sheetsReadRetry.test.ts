import test from 'node:test';
import assert from 'node:assert/strict';
import { leerSheetsConReintento } from './sheetsReadRetry';

test('recupera la lectura tras agotar cuota sin repetir la operación posterior', async () => {
  let lecturas = 0, escrituras = 0;
  const pausas: number[] = [];
  const resultado = await leerSheetsConReintento(async () => {
    if (++lecturas < 3) throw { response: { status: 429 } };
    return { id: 'gasto-existente' };
  }, async ms => { pausas.push(ms); });
  escrituras++;
  assert.equal(resultado.id, 'gasto-existente');
  assert.equal(lecturas, 3);
  assert.equal(escrituras, 1);
  assert.deepEqual(pausas, [35000, 35000]);
});

test('cuota persistente tiene límite y conserva el error original', async () => {
  const error = { code: 429 }; let llamadas = 0;
  await assert.rejects(leerSheetsConReintento(async () => { llamadas++; throw error; }, async () => {}), e => e === error);
  assert.equal(llamadas, 3);
});

test('no reintenta fallos de permisos ni errores indeterminados', async () => {
  for (const error of [{ code: 403 }, new Error('conexión'), null]) {
    let llamadas = 0;
    await assert.rejects(leerSheetsConReintento(async () => { llamadas++; throw error; }, async () => { assert.fail('No debe esperar'); }), e => e === error);
    assert.equal(llamadas, 1);
  }
});
