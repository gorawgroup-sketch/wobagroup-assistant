import { useEffect, useRef } from 'react';
import NanoField from './NanoField.jsx';
import AreaIcon, { AREA_COLORS } from './AreaIcon.jsx';
import { AREAS } from './organization.mjs';

/** All real tools stay in the same shell; only presentation is adapted here. */
export default function ModuleWorkspace({ module, modules, onOpen, onBack, onRefresh, refreshing, status, data, company, scopeNote, children }) {
  const title = useRef(null);
  const companyData = ['holded','drive','seguros','fiscal','calendario','cashflow'].includes(module.id);
  const areaIndex = AREAS.findIndex(area => area.modules.some(item => item.id === module.id));
  const area = AREAS[areaIndex] || AREAS[AREAS.length - 1];
  useEffect(() => { title.current?.focus({ preventScroll: true }); window.scrollTo({ top:0,behavior:'instant' }); }, [module.id]);
  return <main className="nv-module-workspace" aria-label={`Herramienta ${module.name}`} style={{ '--area-color': AREA_COLORS[areaIndex < 0 ? 10 : areaIndex] }}>
    <div className="nv-workspace-nav"><button type="button" onClick={onBack}>← Volver al núcleo</button><label><span>Cambiar herramienta</span><select aria-label="Cambiar herramienta" value={module.id} onChange={event => onOpen(event.target.value)}>{modules.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    <header className="nv-module-heading"><div className="nv-module-identity"><span className="nv-module-glyph"><NanoField compact /><span className="nv-emblem-badge"><AreaIcon id={area.id} /></span></span><div><span className="nv-module-kicker">WOBi / {area.name}</span><h1 tabIndex={-1} ref={title}>{module.name}</h1><p>{module.id === 'cashflow' && company.id === 'Footprint' ? 'Cashflow no conectado · Footprint Global' : companyData ? `Datos de ${company.name}` : module.detail || 'Herramientas del sistema'}</p></div></div>{module.id === 'strategic_planning' ? <div className="nv-module-live"><span style={{color:'#e8bd83'}}>● Hoja pendiente</span><small>Sin lectura de planeación</small></div> : <div className="nv-module-live"><span style={{color:status.color}}>● {status.texto}</span><small>Lectura · {data?.cacheadoEn ? new Date(data.cacheadoEn).toLocaleString('es-ES') : 'pendiente'}</small><button type="button" disabled={refreshing} onClick={() => onRefresh('manual')}>{refreshing ? 'Actualizando…' : 'Actualizar ahora'} ↻</button></div>}</header>
    {scopeNote && <p className="nv-scope-note"><span>Vista · {company.name}</span>{scopeNote}</p>}
    {module.desc && <details className="nv-module-about"><summary>Sobre esta herramienta y su alcance</summary><p>{module.desc}</p><small>El alcance de cada fuente se indica en la cabecera. El selector no cambia permisos de acceso.</small></details>}
    <section className="nv-module-surface" aria-label={`Información de ${module.name}`} key={module.id}>{children}</section>
  </main>;
}
