// Una escucha iniciada por el usuario; nunca vuelve a encender el micrófono sola.
export function startDictation(Recognition, { onListening, onTranscript, onSubmit, onError }) {
  const recognition = new Recognition();
  let cancelled = false, ended = false, failed = false, text = '';
  recognition.lang = 'es-ES';
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.onstart = () => { if (!cancelled) onListening(true); };
  recognition.onresult = event => {
    if (cancelled || ended || failed) return;
    text = Array.from(event.results).filter(result => result.isFinal).map(result => result[0]?.transcript || '').join(' ').trim();
    onTranscript(text);
  };
  recognition.onerror = event => {
    if (cancelled || ended) return;
    failed = true;
    onError(event.error === 'not-allowed' ? 'No tengo permiso para usar el micrófono. Permítelo en el navegador o escribe tu petición.' : 'No pude transcribir el audio. Puedes reintentar o escribir.');
  };
  recognition.onend = () => {
    if (cancelled || ended) return;
    ended = true;
    onListening(false);
    if (failed) return;
    if (!text) { onError('No escuché una petición. Pulsa el micrófono e inténtalo de nuevo.'); return; }
    if (text.length > 200) { onError('La petición es demasiado larga. Dila más corta o escríbela; no enviaré una frase recortada.'); return; }
    onSubmit(text);
  };
  try { recognition.start(); } catch { failed = true; ended = true; onListening(false); onError('No pude activar el micrófono. Puedes escribir.'); }
  return {
    stop: () => { if (!cancelled && !ended) recognition.stop(); },
    abort: () => { cancelled = true; onListening(false); recognition.abort(); }
  };
}
