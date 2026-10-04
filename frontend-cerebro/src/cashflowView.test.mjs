import test from 'node:test';
import assert from 'node:assert/strict';
import { cashflowRows, companyCashflowRows } from './modules/nucleo/cashflowView.mjs';
import { scopeSnapshot } from './modules/nucleo/companyScope.mjs';

const snapshot = {
  cashflow: {
    balanceUltimaSemana: { semana: 'S40', balanceFinal: 100 },
    balanceUltimoMes: { mesLabel: 'octubre 2026', balanceFinal: 200, ingresos: 300, gastos: 100 },
    propuestasPendientes: [{ empresa: 'WOBA' }, { empresa: 'EWORKS' }],
    pagosRecurrentes: [{ empresa: 'WOBA' }],
    alertasPagosRecurrentesProximas: [],
    ultimaDeteccionHolded: '2026-10-04T10:00:00Z',
  },
  fuentes: ['cashflow.semanas', 'cashflow.propuestas', 'cashflow.ultimoRun'].map(fuente => ({ fuente, ok: true })),
};
const money = amount => `${amount} €`;
const ago = () => 'hace 1 h';

test('the shared cashflow changes weekly and monthly balances without assigning them to WOBA', () => {
  const company = scopeSnapshot('cashflow', snapshot, 'WOBA');
  assert.equal(company.cashflow.balanceUltimaSemana, null);
  assert.equal(company.cashflow.balanceUltimoMes, null);
  assert.deepEqual(companyCashflowRows(company, 'WOBA').slice(0, 2), [
    ['Propuestas pendientes', '1'], ['Pagos recurrentes catalogados', '1'],
  ]);
  assert.deepEqual(cashflowRows(snapshot, 'semana', money, ago)[0], ['Balance S40', '100 €']);
  assert.deepEqual(cashflowRows(snapshot, 'mes', money, ago).slice(0, 3), [
    ['Balance octubre 2026', '200 €'], ['Ingresos de octubre 2026', '300 €'], ['Gastos de octubre 2026', '100 €'],
  ]);
});

test('eWorks and Footprint never inherit either balance from the shared file', () => {
  for (const companyId of ['EWORKS', 'Footprint']) {
    const company = scopeSnapshot('cashflow', snapshot, companyId);
    assert.equal(company.cashflow.balanceUltimaSemana, null);
    assert.equal(company.cashflow.balanceUltimoMes, null);
    assert.equal(company.cashflow.linkSheet, null);
  }
  assert.deepEqual(companyCashflowRows(scopeSnapshot('cashflow', snapshot, 'EWORKS'), 'EWORKS').slice(0, 2), [
    ['Propuestas pendientes', '1'], ['Pagos recurrentes catalogados', '0'],
  ]);
  assert.deepEqual(companyCashflowRows(scopeSnapshot('cashflow', snapshot, 'Footprint'), 'Footprint'), []);
});

test('failed financial sources never present retained numbers as current', () => {
  const stale = { ...snapshot, fuentes: snapshot.fuentes.map(item => ({ ...item, ok: false, conservado: true })) };
  const rows = cashflowRows(stale, 'mes', money, ago);
  assert.deepEqual(rows[0], ['Balance del periodo', 'Sin lectura actual']);
  assert.deepEqual(rows[1], ['Propuestas pendientes', 'Sin lectura actual']);
  assert.deepEqual(rows[3], ['Última revisión de Holded', 'Sin lectura actual']);
  assert.deepEqual(companyCashflowRows(scopeSnapshot('cashflow', stale, 'WOBA'), 'WOBA')[0], ['Propuestas pendientes', 'Sin lectura actual']);
});
