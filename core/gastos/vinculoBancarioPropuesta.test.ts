import test from 'node:test';
import assert from 'node:assert/strict';
import { guardarVinculoBancarioPropuesta } from './vinculoBancarioPropuesta';
import { construirTecladoGasto, opcionesTecladoDesdePropuesta } from './gastoTeclado';
import type { PropuestaGasto } from './gastoProposalSheet';

const propuesta: PropuestaGasto = {
  id: 'synthetic', empresa: 'Footprint', proveedor: 'Uber', monto: 12,
  moneda: 'EUR', fecha: '2026-01-15', concepto: 'Taxi', rutaLocal: '/tmp/test.pdf',
  nombreArchivoOriginal: 'test.pdf', candidatos: [], lineas: [], chatId: 1, messageId: 0, creadoEn: 1,
};
const movimiento = { accountId: 'account-test', movementId: 'movement-test',
  descripcion: 'Uber Pending', monto: -12, moneda: 'EUR', fecha: propuesta.fecha };
const acciones = (p: PropuestaGasto) => construirTecladoGasto(p, opcionesTecladoDesdePropuesta(p)).flat().map(b => b.callback_data);

test('primera publicación y repintado ofrecen las mismas acciones tras guardar banco', async () => {
  let durable = { ...propuesta };
  const actualizada = await guardarVinculoBancarioPropuesta(propuesta, [movimiento], true, {
    movimientos: async (id, movimientos) => { assert.equal(id, propuesta.id); durable.movimientosAmbiguos = movimientos; return true; },
    flag: async (id, flag) => { assert.equal(id, propuesta.id); durable.hayMovimientoBancario = flag; return true; },
  });
  assert.equal(propuesta.movimientosAmbiguos, undefined);
  assert.deepEqual(acciones(actualizada), acciones(durable));
  assert.ok(acciones(actualizada).includes('gasto_toggle:synthetic:crearconciliar'));
  assert.ok(acciones(actualizada).includes('gasto_toggle:synthetic:crear'));
});

test('fallo de cualquiera de las escrituras impide publicar acciones', async () => {
  for (const fallo of ['movimientos', 'flag']) {
    await assert.rejects(guardarVinculoBancarioPropuesta(propuesta, [movimiento], true, {
      movimientos: async () => fallo !== 'movimientos', flag: async () => fallo !== 'flag',
    }), /guardar durablemente/);
  }
});

test('guardar datos no salta la incompatibilidad entre taxi y alimentación: no se concilia, pero crear sin conciliar sigue disponible', async () => {
  const p = await guardarVinculoBancarioPropuesta(propuesta, [{ ...movimiento, descripcion: 'Restaurante Osteria' }], true, {
    movimientos: async () => true, flag: async () => true,
  });
  assert.equal(acciones(p).some(a => a?.startsWith('gasto_toggle:synthetic:crearconciliar')), false);
  assert.equal(acciones(p).includes('gasto_toggle:synthetic:crear'), true);
});

test('varios cargos conservan la elección y ningún cargo no permite conciliar', async () => {
  for (const movimientos of [[], [movimiento, { ...movimiento, movementId: 'other' }]]) {
    const p = await guardarVinculoBancarioPropuesta(propuesta, movimientos, false, {
      movimientos: async () => true, flag: async () => true,
    });
    assert.equal(acciones(p).includes('gasto_toggle:synthetic:crearconciliar'), false);
    assert.equal(acciones(p).includes('gasto_toggle:synthetic:crearconciliar_0'), movimientos.length > 0);
  }
});
