import { useEffect, useRef, useState } from 'react';
export const TELEGRAM_URL = 'https://t.me/Woba_asistente_bot';
export const TELEGRAM_WEB_URL = 'https://web.telegram.org/k/#@Woba_asistente_bot';

/** Explicit handoff: never sends a message or passes business text through a URL. */
export default function TelegramHandoff({ question, onClose }) {
  const dialog = useRef(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous?.focus?.(); };
  }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(question); setCopied(true); }
    catch { setCopied(false); dialog.current?.querySelector('textarea')?.select(); }
  };
  return <dialog ref={dialog} className="nv-handoff" onCancel={onClose} aria-labelledby="nv-handoff-title">
    <div className="nv-document-title"><h2 id="nv-handoff-title">Continúa con WOBi en Telegram</h2><button onClick={onClose} type="button" aria-label="Cerrar consulta para Telegram">×</button></div>
    <p>Esta es la consulta que preparaste. Cópiala y envíala a WOBi en Telegram para continuar con el contexto y las confirmaciones de ese canal.</p>
    <textarea readOnly value={question} aria-label="Consulta para Telegram" rows={6} />
    <div className="nv-handoff-actions"><button type="button" onClick={copy}>{copied ? 'Consulta copiada' : 'Copiar consulta'}</button><a href={TELEGRAM_WEB_URL} target="_blank" rel="noopener noreferrer">Abrir Telegram Web ↗</a></div>
  </dialog>;
}
