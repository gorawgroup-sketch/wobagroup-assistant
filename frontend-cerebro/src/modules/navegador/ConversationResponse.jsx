import { readingDate } from './response.mjs';
import { companyById } from '../nucleo/organization.mjs';
import './conversation.css';
export default function ConversationResponse({result}) {
  if(!result?.resumen)return null;
  const l=result.lectura;
  return <section className={`nv-conversation-response nv-conversation-response--${l?.estado||'orientacion'}`} aria-label="Respuesta de WOBi">
    <span className="nv-conversation-label">Respuesta de WOBi · Solo lectura</span>
    <p className="nv-conversation-summary">{result.resumen}</p>
    {result.companyId&&<p className="nv-conversation-context">{l?.tipo==='seguros_actividad'?'Grupo completo':companyById(result.companyId).name}{result.companyOrigen==='contexto'?' · Compañía de la conversación':''}</p>}
    {l&&<><p className="nv-conversation-quality"><strong>{l.estado==='completa'?'Lectura completa':l.estado==='incompleta'?'Lectura incompleta · puede contener datos anteriores':'Fuente no consultable'}</strong> · {readingDate(l.leidoEn)}{l.leidoEn?' · Madrid':''}{l.refrescando?' · Actualización en curso':''}</p>
      {l.avisos.length>0&&<ul>{l.avisos.map((a,i)=><li key={i}>{a}</li>)}</ul>}
      {l.fuentes.length>0&&<details><summary>Fuentes de esta respuesta</summary><ul>{l.fuentes.map((f,i)=><li key={i}>{f.fuente} · {f.conservado?'Dato conservado':f.ok?'Lectura correcta':'Lectura fallida'} · {readingDate(f.ultimoExitoEn)}</li>)}</ul></details>}
    </>}
  </section>;
}
