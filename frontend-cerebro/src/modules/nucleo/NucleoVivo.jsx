import { useEffect, useRef, useState } from 'react';
import WobiAvatar from '../../WobiAvatar.jsx';
import NanoField from './NanoField.jsx';
import DocumentSearch from './DocumentSearch.jsx';
import { TELEGRAM_URL, TELEGRAM_WEB_URL } from './TelegramHandoff.jsx';
import { AREAS, COMPANIES, STAGES, areaById, companyById } from './organization.mjs';
import { systemAttention } from './attention.mjs';
import './nucleo.css';

const COMPANY_KEY = 'wobi_nucleo_company';
function initialCompany() { try { return companyById(localStorage.getItem(COMPANY_KEY)).id; } catch { return 'WOBA'; } }
function dateLabel(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'Todavía sin lectura verificada';
}

export default function NucleoVivo({ apiKey, onClassic, onModule, onRefresh, onLogout, refreshing, status, data, error, isAdmin, name }) {
  const [companyId, setCompanyId] = useState(initialCompany);
  const [areaId, setAreaId] = useState(null);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const searchTrigger = useRef(null);
  const company = companyById(companyId);
  const area = areaById(areaId);
  const failures = [...new Set((data?.fuentes || []).filter(item => !item.ok).map(item => item.fuente.split('.')[0]))];
  const connections = (data?.conexiones || []).filter(item => !item.ok);
  const areas = AREAS.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase('es').includes(filter.toLocaleLowerCase('es')));
  useEffect(() => {
    const onKey = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setDocumentsOpen(true); }
      if (event.key === 'Escape') { setDocumentsOpen(false); searchTrigger.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const chooseCompany = id => {
    setCompanyId(id);
    try { localStorage.setItem(COMPANY_KEY, id); } catch { /* optional preference */ }
  };
  const closeDocuments = () => { setDocumentsOpen(false); searchTrigger.current?.focus(); };

  return <div className="nv-shell">
    <header className="nv-header">
      <a className="nv-wordmark" href="/cerebro/" aria-label="WOBi, inicio">WOB<span>i</span><small>INTELIGENCIA DE WOBA</small></a>
      <label className="nv-company"><span>Espacio de trabajo</span><select value={companyId} onChange={event => chooseCompany(event.target.value)} aria-label="Compañía para buscar documentos">{COMPANIES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="nv-session"><span>{name || 'Mi sesión'}</span><button onClick={onLogout} type="button">Salir ↗</button></div>
    </header>
    <div className="nv-health" role="status">
      <span style={{ '--status-color': status.color }}><i />{status.texto}</span>
      <small>Última lectura · {dateLabel(data?.cacheadoEn || data?.generadoEn)}</small>
      <button onClick={() => onRefresh('manual')} disabled={refreshing} type="button">{refreshing ? 'Actualizando…' : 'Actualizar ahora'} <span aria-hidden="true">↻</span></button>
    </div>
    {(error || failures.length > 0 || connections.length > 0) && <div className="nv-warning" role="status">
      <span>{error || `Lectura con incidencias${failures.length ? `: ${failures.join(', ')}` : ''}. Los datos pueden estar pendientes de actualizar.`}{connections.length > 0 ? ` Conexiones: ${connections.map(item => item.nombre).join(', ')}.` : ''}</span>
      <button type="button" onClick={() => onModule('conexiones')}>Ver conexiones ↗</button>
    </div>}
    <aside className="nv-navigation" aria-label="Áreas de la compañía">
      <button className={`nv-home${!area ? ' is-selected' : ''}`} onClick={() => setAreaId(null)} type="button"><span aria-hidden="true">◉</span> Núcleo vivo <span aria-hidden="true">↗</span></button>
      <div className="nv-nav-label">ÁREAS DE {company.name.toLocaleUpperCase('es')}</div>
      <input className="nv-filter" type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Encontrar un área…" aria-label="Filtrar áreas" />
      <nav>{areas.map(item => <button key={item.id} className={areaId === item.id ? 'is-selected' : ''} onClick={() => setAreaId(item.id)} aria-pressed={areaId === item.id} type="button"><span className="nv-index">{item.symbol}</span><span>{item.short}</span><i className={`nv-area-dot nv-area-dot--${item.stage}`} aria-label={STAGES[item.stage]} /></button>)}</nav>
      {areas.length === 0 && <p className="nv-no-results">No hay áreas con ese nombre.</p>}
      <div className="nv-nav-footer"><span>Herramientas del sistema</span><button type="button" onClick={() => onModule('conexiones')}>Conexiones ↗</button>{isAdmin && <button type="button" onClick={onClassic}>Administración ↗</button>}<button type="button" onClick={onClassic}>Prioridades y control diario ↗</button><button type="button" onClick={onClassic}>Vista clásica ↗</button></div>
    </aside>
    <main className="nv-workspace" aria-label="Núcleo vivo">
      <div className="nv-heading"><span className="nv-eyebrow">{company.name} / {area ? area.name : 'NÚCLEO VIVO'}</span><h1>{area ? area.name : <>Toda tu compañía.<br /><em>En un solo núcleo.</em></>}</h1><p>{area ? area.description : 'Explora tus áreas y encuentra información. Conversa y opera con WOBi desde Telegram.'}</p></div>
      <button className="nv-search-trigger" type="button" ref={searchTrigger} onClick={() => setDocumentsOpen(value => !value)} aria-expanded={documentsOpen} aria-controls="nv-document-space"><span aria-hidden="true">⌕</span><span>Buscar documentos en {company.name}</span><kbd>⌘ / Ctrl K</kbd></button>
      <div id="nv-document-space">{documentsOpen && <DocumentSearch key={companyId} company={company} apiKey={apiKey} onClose={closeDocuments} />}</div>
      {!documentsOpen && <div className={`nv-core${area ? ' nv-core--compact' : ''}`}>
        <NanoField />
        <div className="nv-orbit nv-orbit--one" /><div className="nv-orbit nv-orbit--two" />
        <WobiAvatar className="nv-portrait" transparent headOnly assemble energized />
        {!area && <><button type="button" className="nv-orbit-label nv-orbit-label--finance" onClick={() => setAreaId('finance')}>Finanzas <i /></button><button type="button" className="nv-orbit-label nv-orbit-label--operations" onClick={() => setAreaId('operations')}><i /> Operaciones</button><button type="button" className="nv-orbit-label nv-orbit-label--insurance" onClick={() => setAreaId('insurance')}><i /> Seguros</button></>}
        <span className="nv-core-caption">WOBi <b>·</b> {area ? STAGES[area.stage] : 'Núcleo de inteligencia'}</span>
      </div>}
      {area && <section className="nv-area-detail" aria-label={`Herramientas de ${area.name}`}>
        <span className={`nv-stage nv-stage--${area.stage}`}>{STAGES[area.stage]}</span>
        {area.modules.length > 0 && <><p className="nv-scope-note">Los módulos actuales muestran su propio alcance de datos; algunos incluyen varias compañías.</p><div className="nv-module-list">{area.modules.map(module => <button key={module.id} type="button" onClick={() => onModule(module.id)}>{module.name}<span>↗</span></button>)}</div></>}
        {area.stage === 'planned' && <p className="nv-scope-note">Este espacio está reservado. Su agente especializado aún no está conectado.</p>}
      </section>}
      <footer className="nv-workspace-footer"><span>11 áreas · una estructura para crecer</span><span>WOBA + compañías gestionadas</span></footer>
    </main>
    <aside className="nv-activity" aria-label="Canal principal y estado del sistema">
      <section className="nv-telegram">
        <span className="nv-eyebrow">TU CANAL CON WOBi</span>
        <div className="nv-telegram-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m3 10 18-7-5 18-5-7-8-4Zm8 4L21 3" /></svg></div>
        <h2>Seguimos en <br />Telegram.</h2>
        <p>Conversaciones, instrucciones y confirmaciones, en el canal que ya utilizas.</p>
        <a href={TELEGRAM_WEB_URL} target="_blank" rel="noopener noreferrer">Abrir Telegram Web <span>↗</span></a>
        <small>Se abre en otra pestaña; WOBi permanece aquí. Telegram puede pedirte iniciar sesión.</small>
        <a className="nv-telegram-app" href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Usar la aplicación de Telegram ↗</a>
        <small>La búsqueda interna consulta Drive. Para operar, continúa en Telegram.</small>
      </section>
      <section className="nv-attention" aria-label="Pendientes de todas las compañías">
        <span className="nv-eyebrow">PENDIENTES DEL SISTEMA</span>
        <p>Vista conjunta de las compañías</p>
        {systemAttention(data).map(item => <button key={item.label} type="button" onClick={() => onModule(item.module)}><strong>{item.value ?? '—'}</strong><span>{item.label}{item.value === null && <small>Pendiente de lectura válida</small>}</span><span aria-hidden="true">↗</span></button>)}
        <button className="nv-daily" type="button" onClick={onClassic}>Ver control diario ↗</button>
      </section>
    </aside>
  </div>;
}
