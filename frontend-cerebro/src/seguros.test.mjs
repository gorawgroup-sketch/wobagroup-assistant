import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scopeSnapshot } from './modules/nucleo/companyScope.mjs';
import { SIN_LECTURA, agruparMemoria, agruparProximos, distintivoPoliza, lecturaDisponible, revisionAntigua, separarNotas } from './modules/seguros/segurosView.mjs';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/ejemplos/estado-seguros.json', import.meta.url)), 'utf8'));

test('fixture: los conteos veraces distinguen vigentes, hold y vencidas por compañía', () => {
  assert.equal(fixture.resumen.vigentes, 6);
  assert.equal(fixture.resumen.porConfirmarOEnHold, 2);
  assert.equal(fixture.resumen.vencidas, 1);
  const woba = scopeSnapshot('seguros', { seguros: fixture }, 'WOBA').seguros;
  assert.equal(woba.resumen.vigentes, 4);
  assert.equal(woba.totalPolizasActivas, 4);
  assert.equal(woba.resumen.vencidas, 1);
  assert.equal(woba.resumen.porConfirmarOEnHold, 2);
  assert.ok(woba.proximos.every(e => e.empresa === 'WOBA'));
  assert.equal(scopeSnapshot('seguros', { seguros: fixture }, 'EWORKS').seguros.resumen.vigentes, 1);
  assert.equal(scopeSnapshot('seguros', { seguros: fixture }, 'Footprint').seguros.resumen.vigentes, 1);
});

test('fixture: el distintivo prioriza estado de la póliza sobre pago', () => {
  assert.equal(distintivoPoliza({ estado:'no_contratada', estadoPago:'pagado' }).texto, 'No contratada');
  assert.equal(distintivoPoliza({ estado:'vencida', estadoPago:'pagado' }).texto, 'Vencida');
  assert.equal(distintivoPoliza({ estado:'pendiente_confirmacion', estadoPago:'no_aplica' }).texto, 'En hold / por confirmar');
  assert.equal(distintivoPoliza({ estado:'vigente', estadoPago:'pagado' }).tono, 'success');
  assert.equal(distintivoPoliza({ estado:'vigente', estadoPago:'sin_confirmar' }).tono, 'warning');
  assert.ok(fixture.polizas.some(p => distintivoPoliza(p).texto === 'En hold / por confirmar'));
});

test('fixture: primera frase, hitos cercanos y memoria agrupada', () => {
  const conHistoria = fixture.polizas.find(p => p.notas.includes(' || '));
  assert.ok(conHistoria);
  const notas = separarNotas(conHistoria.notas);
  assert.ok(notas.actual && notas.historia && !notas.actual.includes(' || '));
  const grupos = agruparProximos(fixture.proximos);
  assert.equal(grupos.flatMap(g => g.eventos).length, 11);
  assert.ok(grupos.every(g => g.eventos.every(e => e.polizaId === g.polizaId)));
  const cuotas = agruparProximos([
    {polizaId:'demo',empresa:'WOBA',fecha:'2026-11-01',diasRestantes:27},
    {polizaId:'demo',empresa:'WOBA',fecha:'2026-11-02',diasRestantes:28},
    {polizaId:'demo',empresa:'WOBA',fecha:'2027-03-01',diasRestantes:147},
  ]);
  assert.deepEqual(cuotas.map(g => [g.eventos.length, g.cercano]), [[2, true], [1, false]]);
  assert.ok(grupos.some(g => g.cercano === false));
  assert.equal(grupos.some(g => g.cercano && g.eventos.every(e => e.diasRestantes > 60)), false);
  assert.equal(Object.values(agruparMemoria(fixture.memoria)).flat().length, 16);
  assert.equal(fixture.documentos.length, 2);
  assert.equal(fixture.esperandoACarlos.length, 3);
});

test('fallo de complementos nunca se presenta como cero y la revisión caduca a 24 h', () => {
  const incompleto = { ...fixture, complementosDisponibles:false, memoria:null, esperandoACarlos:null, documentos:null, vigilante:{ ...fixture.vigilante, ultimaRevision:null } };
  assert.equal(lecturaDisponible(incompleto.memoria, incompleto.complementosDisponibles), SIN_LECTURA);
  assert.equal(lecturaDisponible(incompleto.documentos, incompleto.complementosDisponibles), SIN_LECTURA);
  assert.equal(lecturaDisponible(incompleto.esperandoACarlos, incompleto.complementosDisponibles), SIN_LECTURA);
  assert.equal(lecturaDisponible(incompleto.vigilante.ultimaRevision, incompleto.complementosDisponibles), SIN_LECTURA);
  assert.equal(agruparMemoria(null), null);
  assert.equal(revisionAntigua('2026-10-05T08:00:00Z', Date.parse('2026-10-06T08:00:01Z')), true);
  assert.equal(revisionAntigua('2026-10-05T08:00:00Z', Date.parse('2026-10-06T07:59:59Z')), false);
});
