import { useEffect, useRef, useState } from 'react';
import { interpretNavigation } from './client.mjs';
export default function CommandPanel({company,headers,onDestination,onDocuments,onFeedback=()=>{},onStart=()=>{}}) {
  const [query,setQuery]=useState('');
  const [state,setState]=useState({});
  const pending=useRef(null);
  const microphone=useRef(null);
  const [listening,setListening]=useState(false);
  useEffect(()=>()=>microphone.current?.abort(),[]);
  const listen=()=>{
    if(listening){microphone.current?.stop();return;}
    const Recognition=window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!Recognition){setState({error:'Este navegador no admite dictado. Puedes escribir tu petición.'});return;}
    onStart();pending.current?.abort();setState({});
    const recognition=new Recognition();microphone.current=recognition;
    recognition.lang='es-ES';recognition.interimResults=false;recognition.continuous=false;
    recognition.onstart=()=>setListening(true);
    recognition.onend=()=>setListening(false);
    recognition.onerror=()=>{setListening(false);setState({error:'No pude transcribir el audio. Puedes reintentar o escribir.'});};
    recognition.onresult=event=>{const text=event.results[0]?.[0]?.transcript || '';setQuery(text.slice(0,200));setState({dictated:true});};
    try{recognition.start();}catch{setState({error:'No pude activar el micrófono. Puedes escribir.'});}
  };
  useEffect(()=>()=>pending.current?.abort(),[]);
  const run=async(input)=>{
    microphone.current?.abort();setListening(false);
    onStart();
    pending.current?.abort();
    const controller=new AbortController();pending.current=controller;
    setState({loading:true});
    const timer=setTimeout(()=>controller.abort('timeout'),20000);
    try {
      const result=await interpretNavigation({...input,companyId:company.id,requestId:crypto.randomUUID()}, {headers,signal:controller.signal});
      if(controller.signal.aborted||pending.current!==controller)return;
      if(result.tipo==='destino')onDestination(result);else {setState({result});onFeedback(result.tipo==='aclaracion'?result.pregunta:result.mensaje);}
    }catch(error){
      if(pending.current!==controller)return;
      if(controller.signal.aborted&&controller.signal.reason!=='timeout')return;
      const message=controller.signal.reason==='timeout'?'El navegador tardó demasiado. Reintenta.':error.message;setState({error:message});onFeedback(message);
    }finally{clearTimeout(timer);}
  };
  return <section className="nv-command"><h1>Pídele a WOBi</h1><p>Navegación interna · {company.name}</p>
    <form onSubmit={e=>{e.preventDefault();run({texto:query.trim()});}}>
      <label htmlFor="nv-command-query">¿Qué quieres encontrar?</label>
      <input id="nv-command-query" value={query} onChange={e=>{pending.current?.abort();setQuery(e.target.value);setState({});}} placeholder="Por ejemplo: abre Seguros de eWorks" maxLength={200}/>
      <button type="submit" disabled={!query.trim()}>Encontrar destino</button>
    </form>
    <button type="button" className="nv-text-action" aria-pressed={listening} onClick={listen}>{listening?'Detener micrófono':'Dictar petición'}</button>
    <div role="status">{listening&&<p>Escuchando…</p>}{state.dictated&&<p>Revisa lo que entendí y pulsa Encontrar destino.</p>}{state.loading&&<p>Interpretando la petición…</p>}{state.error&&<p>{state.error}</p>}
    {state.result?.tipo==='no_disponible'&&<p>{state.result.mensaje}</p>}
    {state.result?.tipo==='aclaracion'&&<><p>{state.result.pregunta}</p>{state.result.opciones.map((option,index)=><button className="nv-text-action" key={index} type="button" onClick={()=>run({seleccion:{capabilityId:option.capabilityId,companyId:option.companyId}})}>{option.etiqueta}{option.sinFiltro?' · Abrir módulo completo, sin filtro':''} ↗</button>)}</>}</div>
    {state.error&&<button type="button" className="nv-text-action" onClick={()=>run({texto:query.trim()})} disabled={!query.trim()}>Reintentar</button>}
    <button className="nv-text-action" type="button" onClick={onDocuments}>Buscar documentos en Drive ↗</button>
    <small>Solo navegación. No ejecuta operaciones ni calcula cifras. Dictado según compatibilidad del navegador; revisa el texto antes de enviarlo.</small>
  </section>;
}
