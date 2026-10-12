import {pedidoGuidance} from './guidance.mjs';
import {useEffect,useMemo,useRef,useState} from 'react';
import {activePedido,createPedidosClient,historyAfterRef,forgetMissingPedido,loadPedidoId,pedidoStorageKey,savePedidoId} from './client.mjs';
import {TELEGRAM_CHAT_URL,openTelegram} from '../navegador/telegram.mjs';
import TelegramRequest from '../navegador/TelegramRequest.jsx';
import './pedidos.css';
const labels={pendiente_confirmacion:'Borrador · sin enviar',recibido:'Recibido · ejecución pendiente',procesando:'Procesando',terminado:'Procesamiento terminado',fallido:'Resultado incierto',cancelado:'Cancelado · sin enviar',expirado:'Caducado · sin enviar'};
export default function PedidoPanel({headers,request,query,compact=false,onFeedback=()=>{}}){
 const identity=JSON.stringify(headers);
 const client=useMemo(()=>createPedidosClient({headers}),[identity]);
 const storageKey=pedidoStorageKey(headers);
 const [availability,setAvailability]=useState(null),[text,setText]=useState(''),[pedido,setPedido]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[link,setLink]=useState(null),[history,setHistory]=useState(null),[polling,setPolling]=useState(true);
 const current=useRef(null),lock=useRef(false),controller=useRef(null),mounted=useRef(true),lastAction=useRef('status'),feedback=useRef(onFeedback),spoken=useRef(''),requestSeen=useRef(null);
 feedback.current=onFeedback;
 const announce=message=>{if(message&&spoken.current!==message){spoken.current=message;feedback.current(message);}};
 const accept=(p,silent=false)=>{current.current=p;setPedido(p);setError('');if(p.texto!==undefined)setText(p.texto);if(!silent&&(!compact||p.estado!=="pendiente_confirmacion"))announce(compact?pedidoGuidance(p):p.mensaje);};
 const job=async(action,fn)=>{
  if(lock.current)return;
  lock.current=true;lastAction.current=action;setBusy(true);setError('');
  const abort=new AbortController();controller.current=abort;const timeout=setTimeout(()=>abort.abort(),20000);
  try{await fn(abort.signal);}catch(e){if(mounted.current){
   if(['status','availability'].includes(action)&&forgetMissingPedido(e,localStorage,storageKey)){
    current.current=null;setPedido(null);setHistory(null);setText('');setPolling(true);pollCount.current=0;
    const message='No hay pedido para esta referencia. Puedes preparar una solicitud nueva.';setError(message);announce(message);
   }else if(['borrador_caducado','borrador_no_encontrado','pedido_cancelado'].includes(e.codigo)&&current.current?.pedidoId){
    accept({...current.current,estado:e.codigo==='pedido_cancelado'?'cancelado':'expirado',ejecucion:'no_enviada',mensaje:'No se envió nada. Vuelve a escribir la solicitud y revisa el nuevo borrador.'});
   }else{
    if(action==='draft'&&['texto_invalido','texto_no_permitido','sin_vinculo','apagado','entrega_durable_apagada'].includes(e.codigo)){savePedidoId(localStorage,storageKey,null);current.current=null;setPedido(null);}
    setError(e.name==='AbortError'?'La consulta tardó demasiado. Consulta el estado antes de continuar.':e instanceof TypeError?'No pude conectar con WOBi. Consulta el estado antes de continuar.':e.message||'No pude verificar el resultado. Consulta el estado antes de continuar.');
    announce(e.codigo==='recepcion_fallida'?'No se envió nada. Puedes reintentar el envío del mismo pedido.':e.message||'No pude confirmar el resultado. Pulsa Consultar estado antes de continuar.');
   }
   if(e.codigo==='sin_vinculo')setAvailability({disponible:false,motivo:'sin_vinculo',mensaje:e.message});
  }}
  finally{clearTimeout(timeout);if(mounted.current){setBusy(false);lock.current=false;}controller.current=null;}
 };
 const check=(silent=false)=>job('status',async signal=>{if(current.current?.pedidoId)accept(await client.status(current.current.pedidoId,signal),silent);});
 const refreshAvailability=()=>job('availability',async signal=>{const a=await client.availability(signal);setAvailability(a);if(a.disponible){setLink(null);requestSeen.current=null;}});
 useEffect(()=>{
  mounted.current=true;spoken.current='';current.current=null;setPedido(null);setHistory(null);setAvailability(null);setLink(null);setText('');
  const id=loadPedidoId(localStorage,storageKey);
  if(id){current.current={pedidoId:id};setPedido(current.current);}
  job('availability',async signal=>{setAvailability(await client.availability(signal));if(id)accept(await client.status(id,signal));});
  return()=>{mounted.current=false;controller.current?.abort();};
 },[client]);
 useEffect(()=>{
  if(!request||requestSeen.current===request.key)return;
  if(current.current&&['terminado','cancelado','expirado'].includes(current.current.estado)){
   savePedidoId(localStorage,storageKey,null);current.current=null;setPedido(null);setHistory(null);
  }
  if(current.current){requestSeen.current=request.key;const message='Ya tienes una solicitud en seguimiento. Consulta su estado o cancela el borrador antes de enviar otra.';setError(message);announce(message);return;}
  setText(request.text||'');
  if(availability?.disponible&&!lock.current){requestSeen.current=request.key;draft(request.text);}
  else if(availability?.motivo==='sin_vinculo'){requestSeen.current=request.key;announce('Para enviar esta solicitud, vincula una vez este dispositivo con tu Telegram. Pulsa Vincular mi dispositivo.');}
  else if(['apagado','entrega_durable_apagada'].includes(availability?.motivo)){
   requestSeen.current=request.key;
   announce('El envío desde aquí no está disponible. Pulsa Continuar en Telegram para llevar tu petición al chat.');
  }
 },[request,busy,availability]);
 const pollCount=useRef(0);
 useEffect(()=>{
  if(!activePedido(pedido)||!polling)return;
  const timer=setTimeout(()=>{
   if(document.hidden||lock.current)return;
   if(++pollCount.current>=100){setPolling(false);setError('El pedido sigue pendiente. Puedes consultar su estado sin reenviarlo.');return;}
   check(true);
  },3000);
  // Mantiene el sondeo al recuperar foco sin acumular peticiones en segundo plano.
  const visible=()=>{if(!document.hidden&&!lock.current)check(true);};
  document.addEventListener('visibilitychange',visible);
  return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[pedido,busy,polling]);
 const draft=(original=text)=>job('draft',async signal=>{
  const id=current.current?.pedidoId||crypto.randomUUID();
  if(!savePedidoId(localStorage,storageKey,id))throw Error('No puedo guardar la referencia en este navegador. Habilita su almacenamiento antes de preparar el envío.');
  current.current={pedidoId:id};setPedido(current.current);
  const p=await client.draft(original,id,signal);accept(p);
 });
 const confirm=()=>job('confirm',async signal=>{const p=current.current;if(p?.estado!=='pendiente_confirmacion')return;if(!savePedidoId(localStorage,storageKey,p.pedidoId))throw Error('No puedo guardar la referencia en este navegador. No he confirmado el envío.');const confirmed=await client.confirm(p,signal);accept(confirmed);pollCount.current=0;setPolling(true);});
 const cancel=()=>job('cancel',async signal=>accept(await client.cancel(current.current.pedidoId,signal)));
 const createLink=()=>job('link',async signal=>{const l=await client.link(signal);setLink(l);if(l.estado==='vinculado'){requestSeen.current=null;setAvailability(await client.availability(signal));}else announce('Abre tu chat de WOBi en Telegram y envía el código de vinculación que aparece aquí. Después pulsa Ya lo vinculé.');});
 const readHistory=()=>job('history',async signal=>{setHistory(await client.history(signal));});
 const clear=()=>{if(lock.current||activePedido(current.current)||current.current?.estado==='pendiente_confirmacion')return;savePedidoId(localStorage,storageKey,null);current.current=null;setPedido(null);setText('');setError('');setHistory(null);spoken.current='';};
 const messages=pedido?.ref?historyAfterRef(history,pedido.ref):[];
 const preparing=pedido?.estado==='pendiente_confirmacion';
 const unresolved=pedido&&!pedido.estado;
 const ended=pedido&&['terminado','cancelado','expirado'].includes(pedido.estado);
 if(compact&&!request&&!pedido)return null;
 return <section className="nv-pedidos" aria-label="Pedidos a WOBi">
  <h2>{compact?"Continuar con WOBi":"Enviar una solicitud a WOBi"}</h2>
  {!compact&&<p>Procesada como un mensaje tuyo de Telegram. La respuesta y las aprobaciones llegan a tu chat.</p>}
  <div role="status">{busy&&<p>Consultando…</p>}{!availability&&!busy&&<p>Comprobando cómo enviar tu solicitud…</p>}{availability&&!availability.disponible&&<p className="nv-pedido-warning">{availability.mensaje||'El envío no está disponible.'}</p>}{error&&<p className="nv-pedido-warning">{error}</p>}</div>
  {['apagado','entrega_durable_apagada'].includes(availability?.motivo)&&<><p>Puedes continuar en Telegram mientras el envío desde aquí no está disponible.</p><TelegramRequest compact={compact} onFeedback={onFeedback} text={request?.text||text||query||''}/></>}
  {availability?.motivo==='sin_vinculo'&&<div><button type="button" disabled={busy} onClick={createLink}>Vincular mi dispositivo</button>{link?.estado==='pendiente'&&<><p>Escribe <code>/vincular {link.codigo}</code> en tu propio chat de WOBi en Telegram. Caduca a las {new Date(link.expiraEn).toLocaleTimeString('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'})} (Madrid).</p><small>Vincula este navegador con tu identidad de Telegram. Hazlo solo en tu dispositivo.</small><a className="nv-text-action" href={TELEGRAM_CHAT_URL} target="_blank" rel="noopener noreferrer">Abrir mi chat de WOBi ↗</a></>}</div>}
  {!availability?.disponible&&<button type="button" disabled={busy} onClick={refreshAvailability}>{availability?.motivo==='sin_vinculo'?'Ya lo vinculé · comprobar':'Comprobar disponibilidad'}</button>}
  {availability?.disponible&&<p>Destino: tu Telegram{typeof availability.destino?.cuenta==='string'?` · ${availability.destino.cuenta}`:''}.</p>}
  {availability?.disponible&&!pedido&&!compact&&<><label htmlFor="nv-pedido-text">Solicitud exacta</label><textarea id="nv-pedido-text" value={text} onChange={e=>setText(e.target.value)} maxLength={4000} disabled={busy}/><small>{text.length}/4000 · No añado una empresa ni modifico tu solicitud.</small><button type="button" disabled={busy||!query?.trim()} onClick={()=>setText(query)}>Usar lo que acabo de pedir</button><button type="button" disabled={busy||!text.trim()} onClick={()=>draft()}>Preparar envío</button></>}
  {pedido&&<div aria-live="polite"><p className="nv-pedido-state">{labels[pedido.estado]||'Estado aún sin verificar'}{pedido.ref&&` · Ref. ${pedido.ref}`}</p>{pedido.mensaje&&(!compact||!preparing)&&<p>{compact?pedidoGuidance(pedido):pedido.mensaje}</p>}{!compact&&<small>Ejecución: {pedido.ejecucion||'sin verificar'}.</small>}
   {preparing&&!compact&&<><label htmlFor="nv-pedido-confirm-text">Este es el texto que se enviará</label><textarea id="nv-pedido-confirm-text" readOnly value={pedido.texto}/><p>Confirmar envía este texto a WOBi. No aprueba ninguna operación financiera ni sensible; las decisiones siguen en Telegram.</p><small>Borrador válido hasta {new Date(pedido.expiraEn).toLocaleTimeString('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'})} (Madrid).</small><button type="button" disabled={busy||!availability?.disponible||Date.parse(pedido.expiraEn)<=Date.now()} onClick={confirm}>Confirmar y enviar</button><button type="button" disabled={busy||!availability?.disponible} onClick={cancel}>Cancelar borrador</button></>}
   {preparing&&compact&&<>
    <p className="nv-pedido-exact-text">{pedido.texto}</p>
    <button type="button" disabled={busy||!availability?.disponible||Date.parse(pedido.expiraEn)<=Date.now()} onClick={confirm}>{busy?'Enviando…':'Enviar a WOBi en Telegram'}</button>
    <details><summary>Opciones del envío</summary><button type="button" disabled={busy} onClick={cancel}>Cancelar solicitud</button></details>
   </>}
   {unresolved&&<p>No se ha podido verificar este pedido. Consulta su estado; no prepares un pedido nuevo mientras haya dudas.</p>}
   {(activePedido(pedido)||unresolved||error)&&<button type="button" disabled={busy} onClick={()=>check()}>Consultar estado sin reenviar</button>}
   {error&&unresolved&&availability?.disponible&&text&&<button type="button" disabled={busy} onClick={()=>draft()}>Reintentar borrador · misma referencia</button>}
   {pedido.estado==='fallido'&&<p className="nv-pedido-warning">No sé si llegó a hacerse: revisa Telegram. No reenviaré el pedido.</p>}
   {['recibido','procesando','terminado','fallido'].includes(pedido.estado)&&<><a className="nv-text-action" href={TELEGRAM_CHAT_URL} target="_blank" rel="noopener noreferrer">Ver respuesta y decisiones en Telegram ↗</a><button type="button" disabled={busy} onClick={readHistory}>Ver historial de esta referencia aquí</button></>}
   {history&&<div className="nv-pedido-result"><h3>Historial posterior a la referencia</h3>{messages.length?messages.map((m,i)=><pre key={i}>{m.texto}</pre>):<p>Aún no aparece esta referencia en el historial visible. Consulta el chat de Telegram; esto no demuestra que el pedido haya fallado.</p>}<small>Las aprobaciones se hacen en Telegram. Esta vista solo muestra texto.</small></div>}
   {ended&&<button type="button" disabled={busy} onClick={clear}>Preparar otra solicitud</button>}
  </div>}
 </section>;
}
