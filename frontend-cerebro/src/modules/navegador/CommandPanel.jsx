import { useEffect, useRef, useState } from 'react';
import { interpretNavigation } from './client.mjs';
import { conversationReply } from './conversation.mjs';
import { requiresTelegram, wantsTelegramChat, openTelegram } from './telegram.mjs';
import { operationHelp, OPERATION_HELP } from './operationHelp.mjs';
import { financialHelp } from './financialHelp.mjs';
import PedidoPanel from '../pedidos/PedidoPanel.jsx';
import TelegramRequest from './TelegramRequest.jsx';
import ConversationResponse from './ConversationResponse.jsx';
import { startDictation } from './dictation.mjs';
import { companyById } from '../nucleo/organization.mjs';
export default function CommandPanel({company,headers,onDestination,onDocuments,onFeedback=()=>{},onStart=()=>{},conversation,onClear=()=>{}}) {
  const [query,setQuery]=useState('');
  const [state,setState]=useState({});
  const [pedidoRequest,setPedidoRequest]=useState(null);
  const pending=useRef(null);
  const microphone=useRef(null);
  const [listening,setListening]=useState(false);
  useEffect(()=>()=>microphone.current?.abort(),[]);
  const listen=()=>{
    if(listening){microphone.current?.stop();return;}
    const Recognition=window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!Recognition){setState({error:'Este navegador no admite dictado. Puedes escribir tu petición.'});return;}
    onStart();pending.current?.abort();setState({});
    microphone.current?.abort();
    microphone.current=startDictation(Recognition,{
      onListening:setListening,
      onTranscript:text=>setQuery(text.slice(0,200)),
      onSubmit:text=>run({texto:text}),
      onError:message=>setState({error:message})
    });
  };
  useEffect(()=>()=>pending.current?.abort(),[]);
  const run=async(input)=>{
    microphone.current?.abort();setListening(false);
    onStart();
    pending.current?.abort();
    if(financialHelp(input.texto)){
      const reply='Puedo llevar esa solicitud al procesamiento de WOBi. Revisa el texto en el panel de envío y confírmalo; la respuesta llegará a tu Telegram.';
      setPedidoRequest({text:input.texto,key:crypto.randomUUID()});setState({reply});onFeedback(reply);return;
    }
    if(operationHelp(input.texto)){
      setState({reply:OPERATION_HELP});onFeedback(OPERATION_HELP);return;
    }
    if(requiresTelegram(input.texto)&&!wantsTelegramChat(input.texto)){
      const reply='Esta solicitud se procesa como un mensaje tuyo de Telegram. Revisa el texto abajo y confirma el envío. Todavía no he enviado nada.';
      setPedidoRequest({text:input.texto,key:crypto.randomUUID()});setState({reply});onFeedback(reply);return;
    }
    if(wantsTelegramChat(input.texto)){
      const reply='Abro tu chat de WOBi en Telegram.';
      setState({reply,handoff:true,telegram:null});onFeedback(reply);
      if(!openTelegram()){
        const reply='El navegador bloqueó la apertura automática. Pulsa Abrir chat de WOBi para continuar en Telegram.';
        setState({reply,handoff:true,telegram:null});onFeedback(reply);
      }
      return;
    }
    const reply=conversationReply(input.texto);
    if(reply){setState({reply});onFeedback(reply);return;}
    const controller=new AbortController();pending.current=controller;
    setState({loading:true});
    const timer=setTimeout(()=>controller.abort('timeout'),20000);
    try {
      const result=await interpretNavigation({...input,companyId:company.id,requestId:crypto.randomUUID()}, {headers,signal:controller.signal,conversation});
      if(controller.signal.aborted||pending.current!==controller)return;
      if(result.tipo==='destino')onDestination(result);else {setState({result});onFeedback(result.resumen||(result.tipo==='aclaracion'?result.pregunta:result.mensaje));}
    }catch(error){
      if(pending.current!==controller)return;
      if(controller.signal.aborted&&controller.signal.reason!=='timeout')return;
      const message=controller.signal.reason==='timeout'?'El navegador tardó demasiado. Reintenta.':error.message;setState({error:message});onFeedback(message);
    }finally{clearTimeout(timer);}
  };
  return <section className="nv-command"><h1>Pídele a WOBi</h1><p>Navegación interna · {company.name}</p>
    <form onSubmit={e=>{e.preventDefault();run({texto:query.trim()});}}>
      <label htmlFor="nv-command-query">¿Qué quieres encontrar?</label>
      <input id="nv-command-query" value={query} onChange={e=>{pending.current?.abort();microphone.current?.abort();setQuery(e.target.value);setState({});}} placeholder="Por ejemplo: abre Seguros de eWorks" maxLength={200}/>
      <button type="submit" disabled={!query.trim()}>Encontrar destino</button>
    </form>
    <button type="button" className="nv-microphone" aria-pressed={listening} onClick={listen}><svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>{listening?'Terminar y enviar':'Hablar con WOBi'}</button><p className="nv-microphone-help">Pulsa el micrófono y habla. Al terminar, WOBi interpretará tu petición. Si hay que enviarla al procesamiento de Telegram, revisarás el borrador y confirmarás el envío.</p>
    {listening&&<button className="nv-text-action" type="button" onClick={()=>{microphone.current?.abort();setState({reply:'Escucha cancelada. No envié la petición.'});}}>Cancelar escucha</button>}
    <div role="status">{state.reply&&<p>{state.reply}</p>}{state.handoff&&<TelegramRequest key={state.telegram||'chat'} text={state.telegram||''}/>}{listening&&<p>Escuchando…</p>}{state.loading&&<p>Interpretando la petición…</p>}{state.error&&<p>{state.error}</p>}
    {state.result?.resumen&&<ConversationResponse result={state.result}/>}{state.result?.tipo==='no_disponible'&&<>{!state.result.resumen&&<p>{state.result.mensaje}</p>}{state.result.alternativa&&<button className="nv-text-action" type="button" onClick={()=>run({seleccion:{capabilityId:state.result.alternativa.capabilityId,companyId:state.result.alternativa.companyId}})}>{state.result.alternativa.etiqueta} · Abrir módulo completo, sin filtro ↗</button>}</>}
    {state.result?.tipo==='aclaracion'&&<>{!state.result.resumen&&<p>{state.result.pregunta}</p>}{state.result.opciones.map((option,index)=><button className="nv-text-action" key={index} type="button" onClick={()=>run({seleccion:{capabilityId:option.capabilityId,companyId:option.companyId}})}>{option.etiqueta} · {companyById(option.companyId).name}{option.sinFiltro?(option.capabilityId.startsWith('section:')?' · Abrir esta vista, sin filtro adicional':' · Abrir módulo completo, sin filtro'):''} ↗</button>)}</>}</div>
    {state.error&&<button type="button" className="nv-text-action" onClick={()=>run({texto:query.trim()})} disabled={!query.trim()}>Reintentar</button>}
    <PedidoPanel headers={headers} request={pedidoRequest} query={query} onFeedback={onFeedback}/>
    <button className="nv-text-action" type="button" onClick={onDocuments}>Buscar documentos en Drive ↗</button>
    <button className="nv-text-action" type="button" onClick={()=>{pending.current?.abort();microphone.current?.abort();onStart();onClear();setPedidoRequest(null);setQuery('');setState({reply:'Conversación reiniciada. Dime qué quieres encontrar.'});}}>Nueva conversación</button>
    <small>La navegación consulta información. Los pedidos requieren confirmar el texto; las aprobaciones siguen en Telegram. Voz según compatibilidad del navegador.</small>
  </section>;
}
