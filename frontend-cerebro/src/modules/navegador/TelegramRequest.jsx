import { useState } from 'react';
import { TELEGRAM_CHAT_URL, openTelegram } from './telegram.mjs';
export default function TelegramRequest({text,compact=false,onFeedback=()=>{}}){
 const [copied,setCopied]=useState(false),[failed,setFailed]=useState(false);
 const copy=async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);setFailed(false);}catch{setFailed(true);}};
 const continueChat=async()=>{
  try { if(text)await navigator.clipboard.writeText(text);setCopied(true);setFailed(false); }
  catch { setFailed(true);onFeedback('No pude copiar tu petición. El texto sigue aquí para seleccionarlo.');return; }
  if(openTelegram())onFeedback('Tu petición está copiada. Pégala y envíala en tu chat de WOBi.');
  else {setFailed(true);onFeedback('La petición está copiada. Abre el chat de WOBi con el enlace y pégala allí.');}
 };
 if(compact)return <div className="nv-telegram-request"><p>{text}</p><button type="button" onClick={continueChat}>Continuar en Telegram</button>{failed&&<><p>No se ha enviado. Puedes copiar el texto y continuar en tu chat.</p><a href={TELEGRAM_CHAT_URL} target="_blank" rel="noopener noreferrer">Abrir chat de WOBi ↗</a></>}</div>;
 return <div className="nv-telegram-request">
  {text&&<textarea aria-label="Petición para Telegram" readOnly value={text} rows={3}/>}
  {text&&<button type="button" className="nv-text-action" onClick={copy}>{copied?'Petición copiada':'Copiar petición'}</button>}
  {failed&&<p>No pude copiarla. Selecciona el texto para copiarlo.</p>}
  <a className="nv-text-action" href={TELEGRAM_CHAT_URL} target="_blank" rel="noopener noreferrer">Abrir chat de WOBi en Telegram ↗</a>
 </div>;
}
