import { normalizeAssistantName } from './assistantName.mjs';

const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);
const SILENT_ERRORS = new Set(['aborted', 'no-speech']);

const clean = text => normalizeAssistantName(String(text || '').replace(/\s+/g, ' ').trim());

// Mantiene una escucha iniciada por la persona hasta que ella la termina. Chrome
// puede cerrar una sesión de SpeechRecognition después de una pausa aunque
// `continuous` esté activo; en ese caso se abre otra sesión y se conserva todo
// lo ya dictado. Nunca se envía la consulta automáticamente.
export function startDictation(Recognition, { onListening, onTranscript, onReview, onError }, options = {}) {
  const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
  const cancelSchedule = options.cancelSchedule || (timer => clearTimeout(timer));
  const restartDelayMs = options.restartDelayMs ?? 250;
  const maxStartRetries = options.maxStartRetries ?? 3;

  let recognition = null;
  let restartTimer = null;
  let active = true;
  let cancelled = false;
  let stopping = false;
  let finished = false;
  let listeningNotified = false;
  let accumulated = '';
  let sessionText = '';
  let startFailures = 0;

  const combined = () => clean([accumulated, sessionText].filter(Boolean).join(' '));

  const clearRestart = () => {
    if (restartTimer !== null) cancelSchedule(restartTimer);
    restartTimer = null;
  };

  const notifyStopped = () => {
    if (!listeningNotified) return;
    listeningNotified = false;
    onListening(false);
  };

  const commitSession = () => {
    const fragment = clean(sessionText);
    if (fragment) accumulated = clean([accumulated, fragment].filter(Boolean).join(' '));
    sessionText = '';
  };

  const fail = message => {
    if (cancelled || finished) return;
    active = false;
    finished = true;
    clearRestart();
    recognition = null;
    notifyStopped();
    onError(message);
  };

  const finishForReview = () => {
    if (cancelled || finished) return;
    commitSession();
    active = false;
    finished = true;
    clearRestart();
    recognition = null;
    notifyStopped();
    const text = clean(accumulated);
    if (!text) { onError('No escuché una petición. Activa el micrófono e inténtalo de nuevo.'); return; }
    if (text.length > 200) { onError('La petición es demasiado larga. Puedes editarla antes de consultar; no recorté ni envié ninguna parte.'); return; }
    onReview(text);
  };

  const launch = () => {
    if (!active || cancelled || stopping || finished || recognition) return;
    const current = new Recognition();
    recognition = current;
    sessionText = '';
    current.lang = 'es-MX';
    current.interimResults = true;
    current.continuous = true;
    current.onstart = () => {
      if (cancelled || finished || recognition !== current) return;
      startFailures = 0;
      if (!listeningNotified) {
        listeningNotified = true;
        onListening(true);
      }
    };
    current.onresult = event => {
      if (cancelled || finished || recognition !== current) return;
      sessionText = clean(Array.from(event.results).map(result => result[0]?.transcript || '').join(' '));
      const text = combined();
      if (text) onTranscript(text);
    };
    current.onerror = event => {
      if (cancelled || finished || recognition !== current) return;
      const code = event?.error || '';
      if (FATAL_ERRORS.has(code)) {
        fail(code === 'audio-capture'
          ? 'No encuentro un micrófono disponible. Revisa el dispositivo y vuelve a activarlo.'
          : 'No tengo permiso para usar el micrófono. Permítelo en el navegador y vuelve a activarlo.');
        return;
      }
      if (!SILENT_ERRORS.has(code)) onError('El dictado perdió la conexión; WOBi intentará reactivarlo sin borrar lo ya dicho.');
    };
    current.onend = () => {
      if (recognition !== current) return;
      recognition = null;
      commitSession();
      if (cancelled || finished) return;
      if (stopping) { finishForReview(); return; }
      if (!active) return;
      // Una pausa o el límite interno de Chrome no equivale a «terminar».
      // Reanudamos sobre el texto acumulado hasta que la persona pulse el botón.
      restartTimer = schedule(() => {
        restartTimer = null;
        launch();
      }, restartDelayMs);
    };
    try {
      current.start();
    } catch {
      if (recognition === current) recognition = null;
      startFailures += 1;
      if (active && !stopping && startFailures < maxStartRetries) {
        restartTimer = schedule(() => {
          restartTimer = null;
          launch();
        }, restartDelayMs * startFailures);
      } else {
        fail('No pude mantener activo el micrófono. Puedes volver a activarlo para reintentar.');
      }
    }
  };

  launch();
  return {
    stop: () => {
      if (cancelled || finished || stopping) return;
      stopping = true;
      active = false;
      clearRestart();
      if (recognition) recognition.stop();
      else finishForReview();
    },
    abort: () => {
      if (cancelled || finished) return;
      cancelled = true;
      active = false;
      clearRestart();
      const current = recognition;
      recognition = null;
      notifyStopped();
      current?.abort();
    }
  };
}
