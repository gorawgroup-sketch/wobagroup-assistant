import { useEffect, useRef, useState } from 'react';
import { interpretNavigation } from './client.mjs';
import { requiresTelegram, wantsTelegramChat, openTelegram } from './telegram.mjs';
import { operationHelp, OPERATION_HELP } from './operationHelp.mjs';
import OperatingCosts from './OperatingCosts.jsx';
import { operatingCostRequest, operatingCostAnswer, numericRequest } from './operatingCosts.mjs';
import { financialHelp } from './financialHelp.mjs';
import PedidoPanel from '../pedidos/PedidoPanel.jsx';
import './commandPanel.css';
import TelegramRequest from './TelegramRequest.jsx';
import ConversationResponse from './ConversationResponse.jsx';
import { startDictation } from './dictation.mjs';
import { companyById } from '../nucleo/organization.mjs';
export default function CommandPanel({company,headers,data,onControlDaily,onDestination,onDocuments,onFeedback=()=>{},onStart=()=>{},conversation,onClear=()=>{}}) {
  const sessionKey=JSON.stringify(headers);
  useEffect(()=>{pending.current?.abort();microphone.current?.abort();onStart();setQuery('');setState({});setPedidoRequest(null);if(conversation)conversation.current={};},[sessionKey]);
  const [query,setQuery]=useState('');
  const [state,setState]=useState({});
  const [pedidoRequest,setPedidoRequest]=useState(null);
  const pending=useRef(null);
  const queryField=useRef(null);
  const resetInput=({texto="",edit=false,cancelled=false}={})=>{pending.current?.abort();microphone.current?.abort();onStart();setPedidoRequest(null);setQuery(texto);setState(edit?{review:true}:{reply:cancelled?"Borrador cancelado sin enviar. Puedes escribir o dictar otra consulta.":"Texto descartado. Puedes escribir o dictar otra consulta."});queryField.current?.focus();};
  const microphone=useRef(null);
  const [listening,setListening]=useState(false);
  useEffect(()=>()=>microphone.current?.abort(),[]);
  const listen=()=>{
    if(listening){microphone.current?.stop();return;}
    onStart({voice:true});pending.current?.abort();setState({});
    const Recognition=window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!Recognition){const message='Este navegador no admite dictado. Puedes escribir tu petición.';setState({error:message});onFeedback(message);return;}
    microphone.current?.abort();
    microphone.current=startDictation(Recognition,{
      onListening:setListening,
      onTranscript:text=>setQuery(text),
      onReview:text=>{setQuery(text);setState({review:true});queryField.current?.focus();},
      onError:message=>{setState({error:message});onFeedback(message)}
    });
  };
  useEffect(()=>()=>pending.current?.abort(),[]);
  const run=async(input)=>{
    microphone.current?.abort();setListening(false);
    onStart();
    pending.current?.abort();
    setPedidoRequest(null);
    const handoff=(text,message)=>{
      const reply=message+' Pulsa Enviar a WOBi en Telegram. La respuesta llegará a tu chat.';
      setPedidoRequest({text,key:crypto.randomUUID()});
      setState({reply});onFeedback(reply);
    };
    if(operatingCostRequest(input.texto)){
      const costs=operatingCostAnswer(input.texto,data);
      if(!costs.available){handoff(input.texto,costs.summary);return;}
      setState({costs});onFeedback(costs.summary);
      return;
    }
    if(financialHelp(input.texto)){
      handoff(input.texto,'Esta consulta necesita el procesamiento de WOBi.');return;
    }
    if(operationHelp(input.texto)){
      setState({reply:OPERATION_HELP});onFeedback(OPERATION_HELP);return;
    }
    if(requiresTelegram(input.texto)&&!wantsTelegramChat(input.texto)){
      handoff(input.texto,'Esta solicitud necesita el procesamiento de WOBi.');return;
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
    const controller=new AbortController();pending.current=controller;
    setState({loading:true});
    const timer=setTimeout(()=>controller.abort('timeout'),20000);
    try {
      const result=await interpretNavigation({...input,companyId:company.id,requestId:crypto.randomUUID()}, {headers,signal:controller.signal,conversation});
      if(controller.signal.aborted||pending.current!==controller)return;
      if(result.tipo!=='destino'&&numericRequest(input.texto)&&result.motivo!=='permiso_insuficiente'&&result.motivo!=='agente_previsto'){
        handoff(input.texto,'Esta consulta necesita el procesamiento de WOBi para obtener los datos verificados.');return;
      }
      if(result.tipo==='destino')onDestination(result);else {setState({result});onFeedback(result.resumen||(result.tipo==='aclaracion'?result.pregunta:result.mensaje));}
    }catch(error){
      if(pending.current!==controller)return;
      if(controller.signal.aborted&&controller.signal.reason!=='timeout')return;
      if(numericRequest(input.texto)){handoff(input.texto,'No pude completar la consulta aquí. Puedes continuar con WOBi en Telegram.');return;}
      const message=controller.signal.reason==='timeout'?'El navegador tardó demasiado. Reintenta.':error.message;setState({error:message});onFeedback(message);
    }finally{clearTimeout(timer);}
  };
  return <section className="nv-command">
    <div className="nv-command-primary"><div><h1>Pídele a WOBi</h1><p>{company.name}</p></div>
    <button type="button" className="nv-microphone" aria-pressed={listening} onClick={listen}><svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>{listening?'Terminar dictado':'Hablar con WOBi'}</button>
    </div>

    <form onSubmit={e=>{e.preventDefault();run({texto:query.trim()});}}>
      <label htmlFor="nv-command-query">¿Qué necesitas?</label>
      <input ref={queryField} id="nv-command-query" value={query} onChange={e=>{pending.current?.abort();microphone.current?.abort();setQuery(e.target.value);setState({});}} placeholder="Por ejemplo: abre Seguros de eWorks" maxLength={200}/>
      <button type="submit" disabled={!query.trim()||query.length>200}>Consultar</button>
    </form>
    {pedidoRequest&&state.reply&&<p role="status">{state.reply}</p>}
    {state.review&&<p role="status">Revisa lo que entendí y corrige el texto, especialmente los nombres. Pulsa Consultar cuando esté bien.</p>}
    {query.trim()&&!pedidoRequest&&!state.loading&&<div className="nv-input-actions"><button type="button" onClick={()=>resetInput()}>Descartar texto</button><button type="button" onClick={listen}>Dictar de nuevo</button></div>}
    {state.loading&&<button type="button" onClick={()=>resetInput()}>Cancelar consulta</button>}
    {listening&&<button type="button" onClick={()=>resetInput()}>Cancelar dictado</button>}
    <PedidoPanel compact headers={headers} request={pedidoRequest} query={query} onFeedback={onFeedback} onReset={resetInput}/>

    <div role="status">{state.reply&&!pedidoRequest&&<p>{state.reply}</p>}{state.costs&&<OperatingCosts answer={state.costs} onOpen={onControlDaily}/>}{state.handoff&&<TelegramRequest key={state.telegram||'chat'} text={state.telegram||''}/>}{listening&&<p>Escuchando…</p>}{state.loading&&<p>Interpretando la petición…</p>}{state.error&&<p>{state.error}</p>}
    {state.result?.resumen&&<ConversationResponse result={state.result}/>}{state.result?.tipo==='no_disponible'&&<>{!state.result.resumen&&<p>{state.result.mensaje}</p>}{state.result.alternativa&&<button className="nv-text-action" type="button" onClick={()=>run({seleccion:{capabilityId:state.result.alternativa.capabilityId,companyId:state.result.alternativa.companyId}})}>{state.result.alternativa.etiqueta} · Abrir módulo completo, sin filtro ↗</button>}</>}
    {state.result?.tipo==='aclaracion'&&<>{!state.result.resumen&&<p>{state.result.pregunta}</p>}<details key={state.result.pregunta} className="nv-command-choices" open={state.result.opciones.length<=2}><summary>Elegir un área · {state.result.opciones.length} opciones</summary>{state.result.opciones.map((option,index)=><button className="nv-text-action" key={index} type="button" onClick={()=>run({seleccion:{capabilityId:option.capabilityId,companyId:option.companyId}})}>{option.etiqueta} · {companyById(option.companyId).name}{option.sinFiltro?(option.capabilityId.startsWith('section:')?' · Abrir esta vista, sin filtro adicional':' · Abrir módulo completo, sin filtro'):''} ↗</button>)}</details></>}</div>
    {state.error&&<button type="button" className="nv-text-action" onClick={()=>run({texto:query.trim()})} disabled={!query.trim()||query.length>200}>Reintentar</button>}
    <details className="nv-command-options"><summary>Ayuda y opciones</summary>
    <p className="nv-microphone-help">Pulsa el micrófono y habla con naturalidad: las pausas no terminan el dictado. Cuando acabes, pulsa Terminar dictado, revisa la transcripción y después pulsa Consultar. Si necesita procesamiento, aparecerá el botón para enviarla a Telegram.</p>
    <button className="nv-text-action" type="button" onClick={onDocuments}>Buscar documentos en Drive ↗</button>
    <button className="nv-text-action" type="button" onClick={()=>{pending.current?.abort();microphone.current?.abort();onStart();onClear();setPedidoRequest(null);setQuery('');setState({reply:'Conversación reiniciada. Dime qué quieres encontrar.'});}}>Nueva conversación</button>
    <small>La navegación consulta información. Los pedidos requieren confirmar el texto; las aprobaciones siguen en Telegram. Voz según compatibilidad del navegador.</small>
    </details>
  </section>;
}
