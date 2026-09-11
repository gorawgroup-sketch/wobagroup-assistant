import { useEffect, useId, useRef, useState } from "react";

const STORAGE_KEY = "wobi_voice_preview";
const GREETING = "Hola, soy Wobi, tu asistente de inteligencia artificial en WOBA Group. Estoy aquí para ayudarte a organizar la información, revisar lo importante y avanzar contigo. Cuando quieras, empezamos.";

export default function WobiVoice({ onSpeakingChange }) {
  const [voices, setVoices] = useState([]);
  const [selected, setSelected] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const utteranceRef = useRef(null);
  const timeoutRef = useRef(null);
  const selectId = useId();
  const supported = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  useEffect(() => {
    onSpeakingChange?.(speaking);
  }, [speaking, onSpeakingChange]);

  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const refresh = () => {
      const spanish = synth.getVoices().filter(v => /^es(?:-|_)/i.test(v.lang));
      const score = v => (/^es[-_]ES$/i.test(v.lang) ? 10 : 0) + (/M[oó]nica|Elvira/i.test(v.name) ? 5 : 0) + (/premium|enhanced|natural/i.test(v.name) ? 2 : 0);
      spanish.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
      setVoices(spanish);
      let saved;
      try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* Optional preference. */ }
      setSelected(current => spanish.find(v => v.voiceURI === current)?.voiceURI || spanish.find(v => v.voiceURI === saved)?.voiceURI || spanish[0]?.voiceURI || "");
    };
    const cancel = () => {
      clearTimeout(timeoutRef.current);
      if (utteranceRef.current) {
        utteranceRef.current.onstart = utteranceRef.current.onend = utteranceRef.current.onerror = null;
        utteranceRef.current = null;
        synth.cancel();
      }
    };
    const onHidden = () => { if (document.hidden) { cancel(); setSpeaking(false); } };
    refresh();
    synth.addEventListener("voiceschanged", refresh);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      cancel();
      synth.removeEventListener("voiceschanged", refresh);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [supported]);

  const toggle = () => {
    const synth = window.speechSynthesis;
    if (utteranceRef.current) {
      utteranceRef.current.onstart = utteranceRef.current.onend = utteranceRef.current.onerror = null;
      utteranceRef.current = null;
      clearTimeout(timeoutRef.current);
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const voice = voices.find(v => v.voiceURI === selected);
    if (!voice) return;
    setError("");
    const utterance = new SpeechSynthesisUtterance(GREETING);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 0.94;
    utterance.pitch = 1;
    const finish = () => {
      clearTimeout(timeoutRef.current);
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      setSpeaking(false);
    };
    utterance.onstart = () => { clearTimeout(timeoutRef.current); setSpeaking(true); };
    utterance.onend = finish;
    utterance.onerror = () => { finish(); setError("No se pudo reproducir esta voz. Prueba otra de la lista."); };
    utteranceRef.current = utterance;
    setSpeaking(true);
    timeoutRef.current = setTimeout(() => {
      utterance.onstart = utterance.onend = utterance.onerror = null;
      finish();
      synth.cancel();
      setError("La voz no respondió. Prueba otra de la lista.");
    }, 8000);
    try { synth.speak(utterance); } catch { finish(); setError("No se pudo iniciar la voz en este navegador."); }
  };

  return (
    <div className="wobi-voice">
      <button type="button" className="wobi-button wobi-button--secondary" onClick={toggle} disabled={!supported || !selected} aria-pressed={speaking}>
        {speaking ? "Detener muestra" : "Escuchar voz de prueba"}
      </button>
      <details>
        <summary>Elegir voz</summary>
        <label htmlFor={selectId}>Voces en español</label>
        <select id={selectId} value={selected} disabled={!voices.length || speaking} onChange={event => {
          setSelected(event.target.value);
          setError("");
          try { localStorage.setItem(STORAGE_KEY, event.target.value); } catch { /* Optional preference. */ }
        }}>
          {!voices.length && <option value="">Sin voces disponibles</option>}
          {voices.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang}</option>)}
        </select>
        <p>Prueba con voces sintéticas de tu dispositivo. La selección se guarda en este navegador.</p>
      </details>
      {!supported && <p role="status">Este navegador no admite la prueba de voz.</p>}
      {supported && !voices.length && <p role="status">No hay voces en español disponibles en este navegador.</p>}
      {error && <p role="status">{error}</p>}
    </div>
  );
}
