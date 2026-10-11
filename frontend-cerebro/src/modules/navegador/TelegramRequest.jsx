import { useState } from 'react';
import { TELEGRAM_CHAT_URL } from './telegram.mjs';
export default function TelegramRequest({text}){
 const [copied,setCopied]=useState(false),[failed,setFailed]=useState(false);
 const copy=async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);setFailed(false);}catch{setFailed(true);}};
 return <div className="nv-telegram-request">
  <textarea aria-label="Petición para Telegram" readOnly value={text} rows={3}/>
  <button type="button" className="nv-text-action" onClick={copy}>{copied?'Petición copiada':'Copiar petición'}</button>
  {failed&&<p>No pude copiarla. Selecciona el texto para copiarlo.</p>}
  <a className="nv-text-action" href={TELEGRAM_CHAT_URL} target="_blank" rel="noopener noreferrer">Abrir chat de WOBi en Telegram ↗</a>
 </div>;
}
