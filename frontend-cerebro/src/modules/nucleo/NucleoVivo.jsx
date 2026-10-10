import { useEffect, useMemo, useRef, useState } from 'react';
import { createStreamingWobiSpeech } from '../../wobiRealtimeSpeech.js';
import NanoField from './NanoField.jsx';
import NanoAmbient from './NanoAmbient.jsx';
import AreaIcon, { AREA_COLORS } from './AreaIcon.jsx';
import CommandPanel from '../navegador/CommandPanel.jsx';
import { validateDestination } from '../navegador/capabilities.mjs';
import DocumentSearch from './DocumentSearch.jsx';
import ModuleWorkspace from './ModuleWorkspace.jsx';
import StrategicPlanning from './StrategicPlanning.jsx';
import { TELEGRAM_URL, TELEGRAM_WEB_URL } from './TelegramHandoff.jsx';
import { AREAS, COMPANIES, STAGES, areaById, companyById } from './organization.mjs';
import { systemAttention } from './attention.mjs';
import { companyScopeNote } from './companyScope.mjs';
import { areaStatus } from './areaStatus.mjs';
import './nucleo.css';

const COMPANY_KEY = 'wobi_nucleo_company';
function initialCompany() { try { return companyById(localStorage.getItem(COMPANY_KEY)).id; } catch { return 'WOBA'; } }
function dateLabel(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'Sin lectura verificada';
}
function Reveal({ title, onClose, children, accent }) {
  const dialog = useRef(null);
  const openedAt = useRef(0);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement;
    openedAt.current = performance.now();
    node.showModal();
    node.querySelector('input')?.focus();
    return () => { node.close(); previous?.focus?.(); };
  }, []);
  return <dialog className="nv-reveal" ref={dialog} onCancel={onClose} aria-label={title} style={{"--area-color":accent || "#66d8f0"}}
    onClickCapture={event => {
      // The second click that opened a disclosure must not activate a tool underneath it.
      if (event.detail > 0 && performance.now()-openedAt.current < 350) { event.preventDefault(); event.stopPropagation(); }
    }}>
    <NanoAmbient />
    <header><span>{title}</span><button type="button" onClick={onClose} aria-label="Cerrar detalle">×</button></header>
    {children}
  </dialog>;
}
const POSITIONS = [[23,24],[77,31],[25,73],[73,76],[47,12],[86,51],[50,88],[14,49],[70,14],[16,88],[87,89],[17,10]];

export default function NucleoVivo({ apiKey, modules, renderModule, onRefresh, onLogout, refreshing, status, data, error, isAdmin, name }) {
  const [companyId, setCompanyId] = useState(initialCompany);
  const [deviceId] = useState(() => {
    const saved=localStorage.getItem('wobi_cerebro_device');
    if(saved && /^[a-zA-Z0-9_-]{16,128}$/.test(saved))return saved;
    const id=crypto.randomUUID().replaceAll('-','');localStorage.setItem('wobi_cerebro_device',id);return id;
  });
  const navigationHeaders={'X-Cerebro-Key':apiKey,'X-Cerebro-Device':deviceId,'X-Cerebro-Nombre':encodeURIComponent(name||''),'Content-Type':'application/json'};
  const [navigationNotice,setNavigationNotice]=useState(null);
  const [voiceEnabled,setVoiceEnabled]=useState(()=>localStorage.getItem('wobi_navigation_voice')==='on');
  const [voiceState,setVoiceState]=useState('idle');
  const [audioLevel,setAudioLevel]=useState(0);
  const [voiceError,setVoiceError]=useState('');
  const speaker=useMemo(()=>createStreamingWobiSpeech({onStateChange:setVoiceState,onAudioLevel:setAudioLevel}),[]);
  useEffect(()=>()=>speaker.dispose(),[speaker]);
  useEffect(()=>{const hide=()=>{if(document.hidden)speaker.stop();};document.addEventListener('visibilitychange',hide);return()=>document.removeEventListener('visibilitychange',hide);},[speaker]);
  const speak=message=>{if(!voiceEnabled)return;setVoiceError('');speaker.speak(message,navigationHeaders).catch(()=>setVoiceError('No pude reproducir la voz. La información sigue disponible por escrito.'));};
  const toggleVoice=()=>{const enabled=!voiceEnabled;setVoiceEnabled(enabled);localStorage.setItem('wobi_navigation_voice',enabled?'on':'off');if(enabled)speaker.activate().catch(()=>setVoiceError('Activa el audio para escuchar a WOBi.'));else speaker.stop();};

  const [panel, setPanel] = useState(null);
  const [areaId, setAreaId] = useState(null);
  const [activeNode, setActiveNode] = useState(null);
  const [workspaceId, setWorkspaceId] = useState(null);
  const availableModules = [...modules, { id:'strategic_planning',name:'Planeación estratégica',detail:'Hoja de seguimiento pendiente de conectar' }, { id:'control_diario',name:'Control diario',detail:'Diagnóstico y prioridades del sistema' }, {id:'administracion',name:'Ajustes y administración',detail:'Usuarios, programaciones y conexiones'}];
  const workspace = availableModules.find(item => item.id === workspaceId);
  const company = companyById(companyId);
  const area = areaById(areaId);
  const selectedStatus = area ? areaStatus(area, data) : null;
  const failures = [...new Set((data?.fuentes || []).filter(item => !item.ok).map(item => item.fuente.split('.')[0]))];
  const connections = (data?.conexiones || []).filter(item => !item.ok);
  const hasIncident = Boolean(error || failures.length || connections.length || data?.actualizacionParcial);
  const visibleAreas = AREAS;
  useEffect(() => {
    const onKey = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPanel('command'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);
  const chooseCompany = id => {
    setCompanyId(id);
    try { localStorage.setItem(COMPANY_KEY, id); } catch { /* optional preference */ }
  };
  const closePanel = () => { setPanel(null); setActiveNode(null); };
  const openModule = id => { setPanel(null); setWorkspaceId(id); };
  const showArea = id => { setActiveNode(id); setAreaId(id); setPanel('area'); };
  const goHome = event => { setNavigationNotice(null); event?.preventDefault?.(); setWorkspaceId(null); setPanel(null); setAreaId(null); setActiveNode(null); };

  return <div className={`nv-shell${workspace ? ' nv-shell--workspace' : ''}`}>
    {!panel && <NanoAmbient />}
    <header className="nv-header">
      <a className="nv-wordmark" href="/cerebro/" onClick={goHome} aria-label="WOBi, mostrar todas las áreas">WOB<span>i</span></a>
      <select className="nv-company" value={companyId} onChange={event => chooseCompany(event.target.value)} aria-label="Compañía para datos y documentos">{COMPANIES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <button type="button" className="nv-settings-shortcut" onClick={() => openModule('administracion')} aria-label="Abrir ajustes y administración" title="Ajustes y administración"><span aria-hidden="true">⚙</span><span>Ajustes</span></button>
      <a className="nv-telegram-shortcut" href={TELEGRAM_WEB_URL} target="_blank" rel="noopener noreferrer" aria-label="Abrir Telegram Web en otra pestaña" title="Conversar con WOBi · Telegram en otra pestaña"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 18-7-5 18-5-7-8-4Zm8 4L21 3" /></svg><span>Telegram</span><small>↗</small></a>
    </header>

    {navigationNotice && <p className="nv-navigation-notice" role="status">{navigationNotice}<button type="button" onClick={()=>setNavigationNotice(null)} aria-label="Cerrar aviso de navegación">×</button></p>}
    {workspace ? <ModuleWorkspace audioLevel={audioLevel} module={workspace} modules={availableModules} onOpen={openModule}
      onBack={() => setWorkspaceId(null)} onRefresh={onRefresh} refreshing={refreshing} status={status} data={data} company={company} scopeNote={companyScopeNote(workspace.id, company.name)}>
      {workspace.id === 'strategic_planning' ? <StrategicPlanning company={company} onOpenDocuments={() => setPanel('documents')} /> : renderModule(workspace.id, openModule, company.id)}
    </ModuleWorkspace> : <main className="nv-universe is-expanded" aria-label="Núcleo de WOBi">
      <div className="nv-constellation">
        <NanoField expanded audioLevel={audioLevel} activeNode={activeNode} nodes={visibleAreas.map((item,index) => { const [x,y] = POSITIONS[index]; return { id:item.id,x,y,flow:areaStatus(item,data).flow }; })} />
        <div className="nv-holo-frame" aria-hidden="true"><span /><span /><span /><span /></div>
        <svg className="nv-holo-orbits" viewBox="0 0 700 580" aria-hidden="true">
          <defs><radialGradient id="nv-floor"><stop stopColor="#41cdea" stopOpacity=".12" /><stop offset="1" stopColor="#41cdea" stopOpacity="0" /></radialGradient></defs>
          <ellipse cx="350" cy="438" rx="214" ry="52" fill="url(#nv-floor)" />
          {[0,1,2,3,4,5].map(i => <ellipse key={i} cx="350" cy="438" rx={95+i*23} ry={13+i*6} />)}
          <ellipse className="nv-holo-ring" cx="350" cy="260" rx="229" ry="76" transform="rotate(-24 350 260)" />
          <ellipse className="nv-holo-ring nv-holo-ring--violet" cx="350" cy="260" rx="209" ry="104" transform="rotate(31 350 260)" />
          <circle className="nv-holo-ticks" cx="350" cy="260" r="184" />
        </svg>
        <button type="button" className="nv-core-trigger" onClick={() => setPanel('map')} aria-label={`Explorar las ${AREAS.length} áreas de ${company.name}`} aria-controls="nv-area-orbit">
          <span className="nv-core-aura" aria-hidden="true" />
        </button>
        <nav id="nv-area-orbit" className="nv-area-orbit" aria-label="Áreas de la compañía">
          {visibleAreas.map((item, index) => {
            const [x, y] = POSITIONS[index];
            const visual = areaStatus(item, data);
            return <button key={item.id} className={`nv-node nv-node--${item.stage} nv-area--${visual.id}`} type="button" onPointerEnter={() => setActiveNode(item.id)} onPointerLeave={() => setActiveNode(null)} onFocus={() => setActiveNode(item.id)} onBlur={() => setActiveNode(null)} onClick={() => showArea(item.id)} title={visual.label} aria-label={`${item.short}: ${visual.label}`} style={{ '--x': `${x}%`, '--y': `${y}%`, '--delay': `${index * 45}ms`, '--area-color': AREA_COLORS[index] }}><span className="nv-node-icon"><AreaIcon id={item.id} /></span><span>{item.short}</span></button>;
          })}
        </nav>
      </div>
      <div className="nv-whisper" aria-live="polite"><span>{`${company.name} · ${AREAS.length} áreas`}</span><small>{'Color pleno: áreas habilitadas · Color tenue: agentes pendientes'}</small></div>
    </main>}

    <div className="nv-voice-control"><button type="button" aria-pressed={voiceEnabled} onClick={toggleVoice}>{voiceEnabled?'Desactivar voz':'Activar voz de WOBi'}</button><span role="status">{voiceError || (voiceState==='playing'?'WOBi está hablando':voiceState==='loading'?'Preparando voz…':voiceState==='blocked'?'Activa el audio para escuchar a WOBi':'')}</span></div>
    <nav className="nv-dock" aria-label="Acciones del núcleo">
      <button type="button" onClick={() => { setWorkspaceId(null); setPanel('map'); }}><span aria-hidden="true">◌</span> Áreas</button>
      <button type="button" className="nv-find" onClick={() => setPanel('command')}><span aria-hidden="true">⌕</span> Pídele a WOBi <kbd>⌘ K</kbd></button>
      <button type="button" onClick={() => setPanel('attention')}><span aria-hidden="true">◦</span> Pendientes</button>
    </nav>
    <footer className="nv-footer">
      <button type="button" className={`nv-status${hasIncident ? ' has-incident' : ''}`} onClick={() => setPanel('status')}><i style={{ background: hasIncident ? '#e8bd83' : status.color }} />{hasIncident ? 'Revisar conexiones' : status.texto}</button>
      <button type="button" onClick={() => setPanel('menu')} aria-label="Abrir opciones de WOBi">WOBi / {company.name}<span aria-hidden="true"> ···</span></button>
    </footer>

    {panel && <Reveal accent={panel === "area" ? AREA_COLORS[AREAS.findIndex(item => item.id === areaId)] : undefined} title={panel === 'documents' ? company.name : panel === 'area' ? `${company.name} / ${area?.name}` : panel === 'attention' ? 'Pendientes del sistema' : panel === 'status' ? 'Estado de las conexiones' : panel === 'map' ? `Áreas de ${company.name}` : 'Tu espacio'} onClose={closePanel}>
      {panel === 'map' && <section className="nv-area-map"><p>Selecciona un área para ver sus herramientas y su estado.</p>{AREAS.map((item,index) => { const visual = areaStatus(item, data); return <button className={`nv-area--${visual.id}`} type="button" key={item.id} onClick={() => showArea(item.id)} style={{'--area-color':AREA_COLORS[index]}}><span className="nv-map-icon"><AreaIcon id={item.id}/></span><span><strong>{item.name}</strong><small>{visual.label}</small></span><span aria-hidden="true">↗</span></button>; })}</section>}
      {panel === 'command' && <CommandPanel key={companyId} company={company} headers={navigationHeaders} onFeedback={speak} onStart={() => { speaker.stop(); if(voiceEnabled)speaker.activate().catch(()=>{}); }} onDocuments={() => setPanel('documents')} onDestination={proposal => {
        const destination=validateDestination(proposal);
        if (!destination) return;
        chooseCompany(destination.companyId);
        setNavigationNotice([`Vista solicitada: ${companyById(destination.companyId).name}.`,...(proposal.avisos||[])].join(' '));
        if (destination.target.kind === 'area') showArea(destination.target.id);
        else if (availableModules.some(item => item.id === destination.target.id)) openModule(destination.target.id);
        speak(`Abro ${proposal.etiqueta || 'el destino solicitado'} en ${companyById(destination.companyId).name}. ${(proposal.avisos||[]).join(' ')}`);
      }} />}
      {panel === 'documents' && <DocumentSearch key={companyId} company={company} apiKey={apiKey} onClose={closePanel} />}
      {panel === 'area' && area && <div className={`nv-area-detail nv-area--${selectedStatus.id}`}><div className="nv-area-hero"><div><span className="nv-area-eyebrow">INTELIGENCIA / {company.name}</span><h1>{area.name}</h1><span className={`nv-stage nv-stage--${area.stage}`}>{STAGES[area.stage]} · {selectedStatus.label}</span></div><span className="nv-area-emblem"><NanoField compact audioLevel={audioLevel} /><span className="nv-emblem-badge"><AreaIcon id={area.id} /></span></span></div><p>{area.description}</p>
        {area.modules.length > 0 && <><div className="nv-module-list">{area.modules.map(module => <button key={module.id} type="button" onClick={() => openModule(module.id)} className="nv-tool-entry"><span className="nv-tool-icon"><AreaIcon id={area.id} /></span><span className="nv-tool-name">{module.name}</span><span className="nv-tool-arrow">↗</span></button>)}</div><small>Al abrir una herramienta se indica si sus datos corresponden a la compañía elegida o al conjunto del sistema.</small></>}
        {area.stage === 'planned' && <small>Su agente especializado todavía no está conectado.</small>}
        <button className="nv-text-action" type="button" onClick={() => setPanel('documents')}>Buscar documentos en {company.name} ↗</button>
      </div>}
      {panel === 'attention' && <section className="nv-attention"><p>Vista conjunta de todas las compañías</p>{systemAttention(data).map(item => <button key={item.label} type="button" onClick={() => openModule(item.module)}><strong>{item.value ?? '—'}</strong><span>{item.label}{item.value === null && <small>Pendiente de lectura válida</small>}</span><span aria-hidden="true">↗</span></button>)}<button className="nv-text-action" type="button" onClick={() => openModule('control_diario')}>Ver control diario ↗</button></section>}
      {panel === 'status' && <section className="nv-state-detail"><h2>{status.texto}</h2>{data?.conexiones?.length > 0 && <div className="nv-connection-graphic"><svg viewBox="0 0 100 100" role="img" aria-label={`${data.conexiones.filter(item => item.ok).length} de ${data.conexiones.length} conexiones verificadas`}><circle cx="50" cy="50" r="41" className="nv-gauge-track" /><circle cx="50" cy="50" r="41" pathLength="100" strokeDasharray={`${100 * data.conexiones.filter(item => item.ok).length / data.conexiones.length} 100`} className="nv-gauge-value" /><text x="50" y="55">{data.conexiones.filter(item => item.ok).length}/{data.conexiones.length}</text></svg><span>Conexiones verificadas<small>Según la última lectura del sistema</small></span></div>}<p>Última lectura · {dateLabel(data?.cacheadoEn || data?.generadoEn)}</p>{hasIncident && <p className="nv-warning">{error || `Lectura con incidencias${failures.length ? `: ${failures.join(', ')}` : ''}. Los datos pueden estar pendientes de actualizar.`}{connections.length > 0 ? ` Conexiones: ${connections.map(item => item.nombre).join(', ')}.` : ''}</p>}<button className="nv-text-action" onClick={() => onRefresh('manual')} disabled={refreshing} type="button">{refreshing ? 'Actualizando…' : 'Actualizar ahora'} ↻</button><button className="nv-text-action" type="button" onClick={() => openModule('conexiones')}>Ver conexiones ↗</button></section>}
      {panel === 'menu' && <section className="nv-options"><h2>{name || 'Mi sesión'}</h2><p>La búsqueda interna consulta Drive. Las conversaciones y operaciones continúan en Telegram.</p><a href={TELEGRAM_WEB_URL} target="_blank" rel="noopener noreferrer">Abrir Telegram Web ↗</a><a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Usar la aplicación de Telegram ↗</a><div className="nv-options-label">Herramientas del sistema</div>{modules.map(item => <button type="button" key={item.id} onClick={() => openModule(item.id)}>{item.name} ↗</button>)}<button type="button" onClick={() => openModule('control_diario')}>Control diario ↗</button><button type="button" onClick={() => openModule('administracion')}>Ajustes y administración ↗</button><button type="button" onClick={onLogout}>Cerrar sesión</button></section>}
    </Reveal>}
  </div>;
}
