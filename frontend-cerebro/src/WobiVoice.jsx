import { useEffect, useRef, useState } from "react";

// One recording of the selected Paulina (es-MX) voice for every device.
const GREETING_AUDIO = `${import.meta.env.BASE_URL}brand/wobi-saludo-paulina-v2.wav`;

export default function WobiVoice({ onSpeakingChange }) {
  const audioRef = useRef(null);
  const requestRef = useRef(0);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    onSpeakingChange?.(status === "playing");
  }, [status, onSpeakingChange]);

  useEffect(() => {
    const audio = audioRef.current;
    const onHidden = () => {
      if (!document.hidden) return;
      requestRef.current += 1;
      audio.pause();
      audio.currentTime = 0;
      setStatus("idle");
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      requestRef.current += 1;
      audio.pause();
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  const toggle = async () => {
    const audio = audioRef.current;
    const request = ++requestRef.current;
    if (status !== "idle") {
      audio.pause();
      audio.currentTime = 0;
      setStatus("idle");
      return;
    }
    setError("");
    setStatus("loading");
    try {
      if (audio.error) audio.load();
      await audio.play();
    } catch {
      if (request !== requestRef.current) return;
      setStatus("idle");
      setError("No se pudo reproducir el saludo. Pulsa de nuevo para reintentarlo.");
    }
  };

  return (
    <div className="wobi-voice">
      <audio ref={audioRef} src={GREETING_AUDIO} preload="none"
        onPlaying={() => setStatus("playing")}
        onWaiting={() => setStatus(current => current === "idle" ? current : "loading")}
        onPause={() => setStatus("idle")}
        onEnded={() => setStatus("idle")}
        onError={() => {
          setStatus("idle");
          setError("No se pudo cargar el saludo. Pulsa de nuevo para reintentarlo.");
        }} />
      <button type="button" className="wobi-button wobi-button--secondary" onClick={toggle} aria-pressed={status !== "idle"}>
        {status === "loading" ? "Cancelar carga" : status === "playing" ? "Detener saludo" : "Escuchar a WOBi"}
      </button>
      {error && <p role="status">{error}</p>}
    </div>
  );
}
