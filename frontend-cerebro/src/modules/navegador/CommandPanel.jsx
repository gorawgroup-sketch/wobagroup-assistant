import { useState } from 'react';
import { buildCapabilities } from './capabilities.mjs';
import { findDestinations } from './resolve.mjs';
export default function CommandPanel({company,onDestination,onDocuments}) {
  const [query,setQuery]=useState('');
  const [result,setResult]=useState(null);
  const catalog=buildCapabilities();
  return <section className="nv-command"><h1>Pídele a WOBi</h1><p>Navegación interna · {company.name}</p>
    <form onSubmit={e=>{e.preventDefault();setResult(findDestinations(query,catalog));}}>
      <label htmlFor="nv-command-query">¿Qué quieres encontrar?</label>
      <input id="nv-command-query" value={query} onChange={e=>{setQuery(e.target.value);setResult(null);}} placeholder="Por ejemplo: abre Seguros o Cashflow" maxLength={500}/>
      <button type="submit" disabled={!query.trim()}>Encontrar destino</button>
    </form>
    <div aria-live="polite">{result?.status==='needs_interpretation' && <p>Esta petición necesita interpretar filtros, compañía o consultar datos. Esa capacidad aún no está conectada. Puedes abrir una herramienta completa abajo; se usará la compañía seleccionada arriba y no se aplicará ningún filtro automáticamente.</p>}
    {result?.status==='unknown' && <p>No encontré un destino con ese nombre. Prueba con el nombre del área o de la herramienta.</p>}
    {result?.entries.map(entry=><button className="nv-text-action" type="button" key={entry.id} onClick={()=>onDestination({capabilityId:entry.id,companyId:company.id})}>{entry.label} · {entry.status==='planned'?'Agente pendiente':'Abrir'} ↗</button>)}</div>
    <details><summary>Explorar destinos disponibles</summary>{catalog.map(entry=><button className="nv-text-action" type="button" key={entry.id} onClick={()=>onDestination({capabilityId:entry.id,companyId:company.id})}>{entry.label}{entry.status==='planned'?' · Agente pendiente':''} ↗</button>)}</details>
    <button className="nv-text-action" type="button" onClick={onDocuments}>Buscar documentos en Drive ↗</button>
    <small>Primera versión: destinos por nombre. Interpretación libre y voz pendientes de conectar.</small>
  </section>;
}
