import test from 'node:test';
import assert from 'node:assert/strict';
import { startDictation } from './modules/navegador/dictation.mjs';

function setup() {
  const sessions = [], submitted = [], errors = [], transcripts = [], listening = [], scheduled = [];
  class Recognition {
    constructor() { sessions.push(this); }
    start() { this.onstart(); }
    stop() { this.onend(); }
    abort() { this.onend(); }
  }
  const schedule = callback => { scheduled.push(callback); return callback; };
  const cancelSchedule = callback => {
    const index = scheduled.indexOf(callback);
    if (index >= 0) scheduled.splice(index, 1);
  };
  const control = startDictation(Recognition, {
    onListening: value => listening.push(value),
    onTranscript: value => transcripts.push(value),
    onReview: value => submitted.push(value),
    onError: value => errors.push(value),
  }, { schedule, cancelSchedule, restartDelayMs: 0 });
  const result = (text, final = true, session = sessions.at(-1)) => {
    const item = [{ transcript: text }]; item.isFinal = final;
    session.onresult({ results: [item] });
  };
  const restart = () => { const callback = scheduled.shift(); assert.ok(callback, 'faltaba el reinicio esperado'); callback(); };
  return { sessions, scheduled, control, result, restart, submitted, errors, transcripts, listening };
}

test('una pausa del navegador reinicia la escucha y solo la persona termina el dictado', () => {
  const s = setup();
  assert.equal(s.sessions[0].continuous, true);
  assert.equal(s.sessions[0].interimResults, true);
  s.result('primera parte');
  s.sessions[0].onend();
  assert.deepEqual(s.submitted, []);
  assert.deepEqual(s.listening, [true]);
  s.restart();
  s.result('segunda parte');
  s.control.stop();
  assert.deepEqual(s.submitted, ['primera parte segunda parte']);
  assert.deepEqual(s.listening, [true, false]);
});

test('varias pausas, incluso silenciosas, conservan la orden completa sin duplicarla', () => {
  const s = setup();
  s.result('abre los gastos');
  s.sessions[0].onend(); s.restart();
  s.sessions[1].onend(); s.restart();
  s.result('y revisa los pendientes');
  s.sessions[2].onend(); s.restart();
  s.result('de esta semana', false);
  assert.equal(s.transcripts.at(-1), 'abre los gastos y revisa los pendientes de esta semana');
  s.control.stop();
  assert.deepEqual(s.submitted, ['abre los gastos y revisa los pendientes de esta semana']);
});

test('terminar durante la pausa cancela el reinicio y deja el texto para revisión', () => {
  const s = setup();
  s.result('consulta los costes');
  s.sessions[0].onend();
  assert.equal(s.scheduled.length, 1);
  s.control.stop();
  assert.equal(s.scheduled.length, 0);
  assert.deepEqual(s.submitted, ['consulta los costes']);
});

test('cancelar descarta el dictado y los eventos tardíos no lo recuperan', () => {
  const s = setup();
  const first = s.sessions[0];
  s.result('abre seguros');
  s.control.abort();
  first.onend();
  first.onerror({ error: 'network' });
  assert.deepEqual(s.submitted, []);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.listening, [true, false]);
});

test('los errores recuperables mantienen la escucha; permiso y micrófono son bloqueos explícitos', () => {
  const transient = setup();
  transient.result('texto conservado');
  transient.sessions[0].onerror({ error: 'network' });
  transient.sessions[0].onend(); transient.restart();
  transient.result('después de reconectar');
  transient.control.stop();
  assert.match(transient.errors[0], /reactivarlo/);
  assert.deepEqual(transient.submitted, ['texto conservado después de reconectar']);

  for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture']) {
    const fatal = setup();
    fatal.sessions[0].onerror({ error: code });
    fatal.sessions[0].onend();
    assert.deepEqual(fatal.submitted, []);
    assert.equal(fatal.scheduled.length, 0);
    assert.equal(fatal.errors.length, 1);
    assert.deepEqual(fatal.listening, [true, false]);
  }
});

test('silencio y texto largo no envían fragmentos automáticamente', () => {
  const silent = setup();
  silent.sessions[0].onerror({ error: 'no-speech' });
  silent.sessions[0].onend(); silent.restart();
  silent.control.stop();
  assert.deepEqual(silent.submitted, []);
  assert.equal(silent.errors.length, 1);

  const long = setup();
  long.result('a'.repeat(201));
  long.control.stop();
  assert.deepEqual(long.submitted, []);
  assert.match(long.errors[0], /editarla/);
});

test('corrige los vocativos Guapi y Bobi sin alterar nombres que no son el asistente', () => {
  const first = setup(); first.result('hola Guapi'); first.control.stop(); assert.deepEqual(first.submitted, ['hola WOBi']);
  const second = setup(); second.result('hola Bobi'); second.control.stop(); assert.deepEqual(second.submitted, ['hola WOBi']);
  const third = setup(); third.result('los gastos de Bobi'); third.control.stop(); assert.deepEqual(third.submitted, ['los gastos de Bobi']);
  assert.equal(first.sessions[0].lang, 'es-MX');
});
