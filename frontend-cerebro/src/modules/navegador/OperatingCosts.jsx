import { readingDate } from './response.mjs';
import './conversation.css';
export default function OperatingCosts({answer,onOpen}){
 return <section className="nv-conversation-response" aria-label="Costos reales de operación">
  <span className="nv-conversation-label">Respuesta de WOBi · Costos de operación</span>
  <p>{answer.summary}</p>
  <p className="nv-conversation-context">{answer.context}</p>
  {answer.readAt&&<p className="nv-conversation-quality">{answer.stale?'Lectura conservada / actualización en curso':'Lectura disponible'} · {readingDate(answer.readAt)} · Madrid</p>}
  {answer.available&&<>
   <p>Proyección mensual (estimación): {answer.projection}</p>
   {answer.breakdown.length>0&&<details><summary>Qué genera el gasto · {answer.breakdownLabel}</summary><ul>{answer.breakdown.map((p,i)=><li key={i}>{p.label}: {p.value}</li>)}</ul></details>}
  </>}
  <button className="nv-text-action" type="button" onClick={onOpen}>Ver control diario ↗</button>
 </section>;
}
