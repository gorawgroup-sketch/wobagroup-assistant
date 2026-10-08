import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scopeSnapshot } from './modules/nucleo/companyScope.mjs';
import { SIN_LECTURA, SIN_ACTIVIDAD, agruparBitacora, distintivoResultado, estadoProgramacion, diaMadrid, horaMadrid, horaAviso, proximaLegible, diasLegibles, mensajeRevision, ordenarDocumentos, separarPagos } from './modules/seguros/segurosView.mjs';
const fixture = JSON.parse(readFileSync(new URL('../../docs/ejemplos/estado-seguros.json', import.meta.url), 'utf8'));

test('fixture: actividad ordenada por día Madrid, sin alterar ni recortar textos', () => {
  const original = structuredClone(fixture.bitacora);
  const grupos = agruparBitacora(fixture.bitacora);
  assert.deepEqual(grupos.map(g => g.dia), ['2026-10-09', '2026-10-08']);
  assert.equal(grupos[0].entradas[0].tarea, 'pagos');
  assert.equal(horaMadrid(grupos[0].entradas[0].cuando), '08:55');
  assert.equal(grupos.flatMap(g => g.entradas).length, fixture.bitacora.length);
  assert.deepEqual(fixture.bitacora, original);
  assert.equal(grupos[1].entradas[0].avisos[0].texto, original[3].avisos[0].texto);
});
test('fixture: filtro de tarea y Solo avisos se combinan, distinguen vacío de fallo', () => {
  assert.equal(agruparBitacora(fixture.bitacora, { tarea:'vigilante' }).flatMap(g => g.entradas).length, 2);
  const avisos = agruparBitacora(fixture.bitacora, { soloAvisos:true }).flatMap(g => g.entradas);
  assert.equal(avisos.length, 1);
  assert.ok(avisos.every(e => e.avisos.length));
  assert.deepEqual(agruparBitacora(fixture.bitacora, { tarea:'pagos', soloAvisos:true }), []);
  assert.equal(agruparBitacora(null), null);
  assert.equal(agruparBitacora(fixture.bitacora, {}, false), null);
  assert.deepEqual(agruparBitacora([]), []);
  assert.match(SIN_ACTIVIDAD, /08-10-2026/);
  const texto = '<img src=x onerror=alert(1)>\n' + 'Resumen íntegro '.repeat(100);
  const fallido = { ...fixture.bitacora[3], avisos:[{ texto, entregado:false }] };
  assert.equal(agruparBitacora([fallido], { soloAvisos:true })[0].entradas[0].avisos[0].texto, texto);
  assert.equal(agruparBitacora([fallido])[0].entradas[0].avisos[0].entregado, false);
});
test('Madrid: cruce de medianoche, cambios de hora y fechas relativas', () => {
  assert.equal(diaMadrid('2026-10-08T23:30:00Z'), '2026-10-09');
  assert.equal(horaMadrid('2026-01-01T07:35:00Z'), '08:35');
  assert.equal(horaMadrid('2026-07-01T06:35:00Z'), '08:35');
  assert.equal(proximaLegible('2026-10-09T15:35:00Z', Date.parse('2026-10-09T06:00:00Z')), 'hoy 17:35');
  assert.equal(proximaLegible('2026-10-10T06:35:00Z', Date.parse('2026-10-09T23:00:00Z')), 'hoy 08:35');
  assert.equal(proximaLegible('2026-03-29T06:35:00Z', Date.parse('2026-03-28T12:00:00Z')), 'mañana 08:35');
  assert.equal(proximaLegible(null), SIN_LECTURA);
  assert.equal(proximaLegible('mal'), SIN_LECTURA);
});
test('resultado, programación retrasada y nueva, revisión vacía e hito de hoy', () => {
  assert.deepEqual(['sin_novedades','con_novedades','con_advertencias','error'].map(x => distintivoResultado(x).tono), ['neutral','success','warning','danger']);
  assert.equal(estadoProgramacion('retrasada').tono, 'danger');
  assert.match(estadoProgramacion('retrasada').texto, /no dejó constancia/);
  assert.equal(estadoProgramacion('sin_lectura').texto, SIN_LECTURA);
  assert.match(estadoProgramacion('sin_registro').texto, /bitácora es nueva/);
  assert.equal(mensajeRevision(null, true), 'Aún sin revisión registrada');
  assert.equal(mensajeRevision(null, false), SIN_LECTURA);
  assert.equal(diasLegibles(0), 'hoy');
  assert.match(diasLegibles(-1), /vencido/);
  assert.equal(diasLegibles(null), 'sin fecha relativa');
});
test('fixture: calendario de pagos por compañía, bitácora y programación siempre conjuntas', () => {
  for (const [empresa, numero] of [['WOBA',3],['EWORKS',2],['Footprint',1]]) {
    const scoped = scopeSnapshot('seguros', { seguros:fixture }, empresa).seguros;
    assert.equal(scoped.calendarioPagos.length, numero);
    assert.ok(scoped.calendarioPagos.every(p => p.empresa === empresa));
    assert.equal(scoped.bitacora, fixture.bitacora);
    assert.equal(scoped.programacion, fixture.programacion);
    assert.equal(scoped.calendario, fixture.calendario);
  }
  assert.equal(scopeSnapshot('seguros', {seguros:{...fixture,calendarioPagos:null}},'WOBA').seguros.calendarioPagos, null);
});
test('calendario: previstos ordenados, cerrados como historia y fallo sin ceros', () => {
  const original = structuredClone(fixture.calendarioPagos);
  const pagos = separarPagos(fixture.calendarioPagos.slice().reverse());
  assert.equal(pagos.previstos[0].fecha, '2027-02-27');
  assert.deepEqual(fixture.calendarioPagos, original);
  for (const estado of ['pagado','devuelto','cancelado']) {
    assert.equal(separarPagos([{ ...original[0], estado }]).historia.length, 1);
  }
  assert.equal(separarPagos(null), null);
  assert.equal(separarPagos(original, false), null);
  assert.deepEqual(separarPagos([]), {previstos:[],historia:[]});
});
test('documentos: seis documentos ordenados con vigencia y resumen de 4000 caracteres íntegro', () => {
  const documentos = Array.from({length:6}, (_,i) => ({...fixture.documentos[0], fechaDocumento:`2026-0${i+1}-01`, resumen:'x'.repeat(4000)}));
  const copia = structuredClone(documentos);
  const ordenados = ordenarDocumentos(documentos);
  assert.equal(ordenados[0].fechaDocumento, '2026-06-01');
  assert.equal(ordenados[5].fechaDocumento, '2026-01-01');
  assert.equal(ordenados[0].resumen.length, 4000);
  assert.equal(ordenados[0].vigencia, documentos[0].vigencia);
  assert.deepEqual(documentos, copia);
  assert.equal(ordenarDocumentos(null), null);
});


test('fixture actualizado: cada aviso muestra su hora de entrega de Madrid, independiente de la ejecución', () => {
  const entrada = fixture.bitacora.find(e => e.avisos.some(a => a.entregadoEn));
  assert.ok(entrada, 'el fixture de main debe incluir una entrega registrada');
  const aviso = entrada.avisos.find(a => a.entregadoEn);
  assert.equal(horaAviso(aviso, '2026-10-08T06:00:00Z'), `Hora de entrega: ${horaMadrid(aviso.entregadoEn)} · Madrid.`);
  assert.equal(horaAviso({ ...aviso, entregadoEn:'2026-01-09T07:50:00Z' }, entrada.cuando), 'Hora de entrega: 08:50 · Madrid.');
  assert.equal(horaAviso({ ...aviso, entregadoEn:'2026-07-09T06:50:00Z' }, entrada.cuando), 'Hora de entrega: 08:50 · Madrid.');
  for (const historico of [{entregado:true}, {entregado:false}, {entregadoEn:null}]) {
    assert.equal(horaAviso(historico, '2026-10-08T15:35:00Z'), 'Hora de ejecución: 17:35 · Madrid. Hora individual de entrega no disponible.');
  }
});
test('avisos completos y recortados conservan el texto y la marca del backend', () => {
  const entrada = fixture.bitacora.find(e => e.avisos.length);
  const texto = '<b>Texto literal</b>\n' + 'a'.repeat(7979);
  assert.equal(texto.length, 8000);
  for (const truncado of [false, true]) {
    const recibida = {...entrada, avisos:[{...entrada.avisos[0],texto,truncado}]};
    const aviso = agruparBitacora([recibida], {soloAvisos:true})[0].entradas[0].avisos[0];
    assert.equal(aviso.texto, texto);
    assert.equal(aviso.truncado, truncado);
  }
});
