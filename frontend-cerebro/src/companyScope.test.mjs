import test from 'node:test';
import assert from 'node:assert/strict';
import { companyScopeNote, scopeSnapshot } from './modules/nucleo/companyScope.mjs';
const sample = {
  holded: { porEmpresa: { WOBA: { facturasUltimos7dias: 1 }, EWORKS: { facturasUltimos7dias: 5 } } },
  drive: { porEmpresa: { WOBA: { archivosUltimos7dias: 2 }, EWORKS: { archivosUltimos7dias: 4 } }, ultimoArchivo: { nombre:'Otro', empresa:'EWORKS' } },
  seguros: { polizas:[{ id:'w',empresa:'WOBA',estado:'vigente' },{ id:'e',empresa:'EWORKS',estado:'vigente' }], proximasARenovar:[{empresa:'EWORKS'}], pagosSinConfirmar:[{empresa:'WOBA'}], totalPolizasActivas:2 },
  fiscal: { proximasAlertas:[{empresa:'WOBA'},{empresa:'Footprint'}], catalogoPagosRecurrentes:[{empresa:'Footprint'}] },
  crm: { actividadesProgramadas:[{empresa:'WOBA'},{empresa:'EWORKS'}] },
  cashflow: { balanceUltimaSemana:{balanceFinal:500}, propuestasPendientes:[{empresa:'WOBA'},{empresa:'EWORKS'}], pagosRecurrentes:[{empresa:'WOBA'},{empresa:'EWORKS'}], alertasPagosRecurrentesProximas:[{empresa:'EWORKS'}], linkSheet:'https://example.com' },
  correo: { correosNoLeidos:3 },
};
test('company context isolates available per-company modules without mutating source', () => {
  const holded = scopeSnapshot('holded', sample, 'EWORKS');
  assert.deepEqual(Object.keys(holded.holded.porEmpresa), ['EWORKS']);
  assert.equal(holded.holded.porEmpresa.EWORKS.facturasUltimos7dias, 5);
  assert.equal(sample.holded.porEmpresa.WOBA.facturasUltimos7dias, 1);
  const drive = scopeSnapshot('drive', sample, 'WOBA');
  assert.equal(drive.drive.ultimoArchivo, null);
  assert.deepEqual(Object.keys(drive.drive.porEmpresa), ['WOBA']);
  const seguros = scopeSnapshot('seguros', sample, 'WOBA');
  assert.equal(seguros.seguros.totalPolizasActivas, 1);
  assert.deepEqual(seguros.seguros.polizas.map(p=>p.id), ['w']);
  assert.equal(seguros.seguros.proximasARenovar.length, 0);
  assert.equal(seguros.seguros.pagosSinConfirmar.length, 1);
  assert.equal(scopeSnapshot('fiscal', sample, 'Footprint').fiscal.proximasAlertas.length, 1);
  assert.equal(scopeSnapshot('calendario', sample, 'WOBA').crm.actividadesProgramadas.length, 1);
});
test('group-only cashflow balances are never attributed to one company', () => {
  const data = scopeSnapshot('cashflow', sample, 'WOBA');
  assert.equal(data.cashflow.balanceUltimaSemana, null);
  assert.equal(data.cashflow.linkSheet, null);
  assert.equal(data.cashflow.propuestasPendientes.length, 1);
  assert.equal(data.cashflow.alertasPagosRecurrentesProximas.length, 0);
  assert.match(companyScopeNote('cashflow', 'WOBA'), /conjuntos/);
});
test('global modules remain explicitly global', () => {
  assert.equal(scopeSnapshot('correo', sample, 'WOBA'), sample);
  assert.match(companyScopeNote('correo', 'WOBA'), /Vista conjunta/);
  assert.equal(scopeSnapshot('seguros', null, 'WOBA'), null);
});
