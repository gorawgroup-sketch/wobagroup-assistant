import { useEffect, useRef, useState } from 'react';
import NanoField from './NanoField.jsx';
import AreaIcon, { AREA_COLORS } from './AreaIcon.jsx';
import DocumentSearch from './DocumentSearch.jsx';
import { TELEGRAM_URL, TELEGRAM_WEB_URL } from './TelegramHandoff.jsx';
import { AREAS, COMPANIES, STAGES, areaById, companyById } from './organization.mjs';
import { systemAttention } from './attention.mjs';
import './nucleo.css';

const COMPANY_KEY = 'wobi_nucleo_company';
function initialCompany() { try { return companyById(localStorage.getItem(COMPANY_KEY)).id; } catch { return 'WOBA'; } }
function dateLabel(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'Sin lectura verificada';
}
function Reveal({ title, onClose, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement;
    node.showModal();
    node.querySelector('input')?.focus();
    return () => { node.close(); previous?.focus?.(); };
  }, []);
  return <dialog className="nv-reveal" ref={dialog} onCancel={onClose} aria-label={title}>
    <header><span>{title}</span><button type="button" onClick={onClose} aria-label="Cerrar detalle">×</button></header>
    {children}
  </dialog>;
}
const POSITIONS = [[23,24],[77,31],[25,73],[73,76],[47,12],[86,51],[50,88],[14,49],[70,14],[16,88],[87,89]];
const PRIMARY_POSITIONS = [[22,28],[79,44],[29,76]];

export default function NucleoVivo({ apiKey, onClassic, onModule, onRefresh, onLogout, refreshing, status, data, error, isAdmin, name }) {
  const [companyId, setCompanyId] = useState(initialCompany);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState(null);
  const [areaId, setAreaId] = useState(null);
  const [activeNode, setActiveNode] = useState(null);
  const company = companyById(companyId);
  const area = areaById(areaId);
  const failures = [...new Set((data?.fuentes || []).filter(item => !item.ok).map(item => item.fuente.split('.')[0]))];
  const connections = (data?.conexiones || []).filter(item => !item.ok);
  const hasIncident = Boolean(error || failures.length || connections.length || data?.actualizacionParcial);
  const visibleAreas = expanded ? AREAS : AREAS.slice(0, 3);
  useEffect(() => {
    const onKey = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPanel('documents'); }
      if (event.key === 'Escape' && !panel) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);
  const chooseCompany = id => {
    setCompanyId(id);
    try { localStorage.setItem(COMPANY_KEY, id); } catch { /* optional preference */ }
  };
  const closePanel = () => { setPanel(null); setActiveNode(null); };
  const openModule = id => { setPanel(null); onModule(id); };
  const showArea = id => { setActiveNode(id); setAreaId(id); setPanel('area'); };

  return <div className="nv-shell">
    <header className="nv-header">
      <a className="nv-wordmark" href="/cerebro/" aria-label="WOBi, inicio">WOB<span>i</span></a>
      <select className="nv-company" value={companyId} onChange={event => chooseCompany(event.target.value)} aria-label="Compañía para buscar documentos">{COMPANIES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <a className="nv-telegram-shortcut" href={TELEGRAM_WEB_URL} target="_blank" rel="noopener noreferrer" aria-label="Abrir Telegram Web en otra pestaña" title="Conversar con WOBi · Telegram en otra pestaña"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 18-7-5 18-5-7-8-4Zm8 4L21 3" /></svg><span>Telegram</span><small>↗</small></a>
    </header>

    <main className={`nv-universe${expanded ? ' is-expanded' : ''}`} aria-label="Núcleo de WOBi">
      <div className="nv-constellation">
        <NanoField expanded={expanded} activeNode={activeNode} nodes={visibleAreas.map((item,index) => { const [x,y] = (expanded ? POSITIONS : PRIMARY_POSITIONS)[index]; return { id:item.id,x,y }; })} />
        <div className="nv-holo-frame" aria-hidden="true"><span /><span /><span /><span /></div>
        <svg className="nv-holo-orbits" viewBox="0 0 700 580" aria-hidden="true">
          <defs><radialGradient id="nv-floor"><stop stopColor="#41cdea" stopOpacity=".12" /><stop offset="1" stopColor="#41cdea" stopOpacity="0" /></radialGradient></defs>
          <ellipse cx="350" cy="438" rx="214" ry="52" fill="url(#nv-floor)" />
          {[0,1,2,3,4,5].map(i => <ellipse key={i} cx="350" cy="438" rx={95+i*23} ry={13+i*6} />)}
          <ellipse className="nv-holo-ring" cx="350" cy="260" rx="229" ry="76" transform="rotate(-24 350 260)" />
          <ellipse className="nv-holo-ring nv-holo-ring--violet" cx="350" cy="260" rx="209" ry="104" transform="rotate(31 350 260)" />
          <circle className="nv-holo-ticks" cx="350" cy="260" r="184" />
        </svg>
        <button type="button" className="nv-core-trigger" onClick={() => setExpanded(value => !value)} aria-label={`${expanded ? 'Contraer' : 'Explorar'} áreas de ${company.name}`} aria-expanded={expanded} aria-controls="nv-area-orbit">
          <span className="nv-core-aura" aria-hidden="true" />
        </button>
        <nav id="nv-area-orbit" className="nv-area-orbit" aria-label="Áreas de la compañía">
          {visibleAreas.map((item, index) => {
            const [x, y] = (expanded ? POSITIONS : PRIMARY_POSITIONS)[index];
            return <button key={item.id} className={`nv-node nv-node--${item.stage}`} type="button" onPointerEnter={() => setActiveNode(item.id)} onPointerLeave={() => setActiveNode(null)} onFocus={() => setActiveNode(item.id)} onBlur={() => setActiveNode(null)} onClick={() => showArea(item.id)} style={{ '--x': `${x}%`, '--y': `${y}%`, '--delay': `${index * 45}ms`, '--area-color': AREA_COLORS[index] }}><span className="nv-node-icon"><AreaIcon id={item.id} /></span><span>{item.short}</span></button>;
          })}
        </nav>
      </div>
      <div className="nv-whisper" aria-live="polite"><span>{expanded ? `${company.name} · Elige un área` : `${company.name} · Núcleo de inteligencia`}</span><small>{expanded ? 'Toca el núcleo para recogerlas' : 'Toca el núcleo para explorar'}</small></div>
    </main>

    <nav className="nv-dock" aria-label="Acciones del núcleo">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span aria-hidden="true">◌</span> Áreas</button>
      <button type="button" className="nv-find" onClick={() => setPanel('documents')}><span aria-hidden="true">⌕</span> Buscar un documento <kbd>⌘ K</kbd></button>
      <button type="button" onClick={() => setPanel('attention')}><span aria-hidden="true">◦</span> Pendientes</button>
    </nav>
    <footer className="nv-footer">
      <button type="button" className={`nv-status${hasIncident ? ' has-incident' : ''}`} onClick={() => setPanel('status')}><i style={{ background: hasIncident ? '#e8bd83' : status.color }} />{hasIncident ? 'Revisar conexiones' : status.texto}</button>
      <button type="button" onClick={() => setPanel('menu')} aria-label="Abrir opciones de WOBi">WOBi / {company.name}<span aria-hidden="true"> ···</span></button>
    </footer>

    {panel && <Reveal title={panel === 'documents' ? company.name : panel === 'area' ? `${company.name} / ${area?.name}` : panel === 'attention' ? 'Pendientes del sistema' : panel === 'status' ? 'Estado de las conexiones' : 'Tu espacio'} onClose={closePanel}>
      {panel === 'documents' && <DocumentSearch key={companyId} company={company} apiKey={apiKey} onClose={closePanel} />}
      {panel === 'area' && area && <div className="nv-area-detail"><h1>{area.name}</h1><span className={`nv-stage nv-stage--${area.stage}`}>{STAGES[area.stage]}</span><p>{area.description}</p>
        {area.modules.length > 0 && <><div className="nv-module-list">{area.modules.map(module => <button key={module.id} type="button" onClick={() => openModule(module.id)}>{module.name}<span>↗</span></button>)}</div><small>Los módulos conservan su alcance actual; algunos incluyen varias compañías.</small></>}
        {area.stage === 'planned' && <small>Su agente especializado todavía no está conectado.</small>}
        <button className="nv-text-action" type="button" onClick={() => setPanel('documents')}>Buscar documentos en {company.name} ↗</button>
      </div>}
      {panel === 'attention' && <section className="nv-attention"><p>Vista conjunta de todas las compañías</p>{systemAttention(data).map(item => <button key={item.label} type="button" onClick={() => openModule(item.module)}><strong>{item.value ?? '—'}</strong><span>{item.label}{item.value === null && <small>Pendiente de lectura válida</small>}</span><span aria-hidden="true">↗</span></button>)}<button className="nv-text-action" type="button" onClick={onClassic}>Ver control diario ↗</button></section>}
      {panel === 'status' && <section className="nv-state-detail"><h2>{status.texto}</h2>{data?.conexiones?.length > 0 && <div className="nv-connection-graphic"><svg viewBox="0 0 100 100" role="img" aria-label={`${data.conexiones.filter(item => item.ok).length} de ${data.conexiones.length} conexiones verificadas`}><circle cx="50" cy="50" r="41" className="nv-gauge-track" /><circle cx="50" cy="50" r="41" pathLength="100" strokeDasharray={`${100 * data.conexiones.filter(item => item.ok).length / data.conexiones.length} 100`} className="nv-gauge-value" /><text x="50" y="55">{data.conexiones.filter(item => item.ok).length}/{data.conexiones.length}</text></svg><span>Conexiones verificadas<small>Según la última lectura del sistema</small></span></div>}<p>Última lectura · {dateLabel(data?.cacheadoEn || data?.generadoEn)}</p>{hasIncident && <p className="nv-warning">{error || `Lectura con incidencias${failures.length ? `: ${failures.join(', ')}` : ''}. Los datos pueden estar pendientes de actualizar.`}{connections.length > 0 ? ` Conexiones: ${connections.map(item => item.nombre).join(', ')}.` : ''}</p>}<button className="nv-text-action" onClick={() => onRefresh('manual')} disabled={refreshing} type="button">{refreshing ? 'Actualizando…' : 'Actualizar ahora'} ↻</button><button className="nv-text-action" type="button" onClick={() => openModule('conexiones')}>Ver conexiones ↗</button></section>}
      {panel === 'menu' && <section className="nv-options"><h2>{name || 'Mi sesión'}</h2><p>La búsqueda interna consulta Drive. Las conversaciones y operaciones continúan en Telegram.</p><a href={TELEGRAM_WEB_URL} target="_blank" rel="noopener noreferrer">Abrir Telegram Web ↗</a><a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Usar la aplicación de Telegram ↗</a><button type="button" onClick={onClassic}>Vista clásica ↗</button>{isAdmin && <button type="button" onClick={onClassic}>Administración ↗</button>}<button type="button" onClick={onLogout}>Cerrar sesión</button></section>}
    </Reveal>}
  </div>;
}
