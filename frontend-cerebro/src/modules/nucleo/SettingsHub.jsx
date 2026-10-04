import { useCallback, useEffect, useState } from 'react';
import { TELEGRAM_WEB_URL } from './TelegramHandoff.jsx';

const TABS = [
  ['overview', 'Resumen'], ['users', 'Usuarios'], ['access', 'Accesos'],
  ['schedules', 'Programaciones'], ['connections', 'Conexiones'],
];
function dateLabel(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('es-ES', { dateStyle:'medium', timeStyle:'short' }) : 'Fecha no válida';
}
function ScheduledActions({ apiKey, actualizacionId }) {
  const [actions,setActions] = useState(null);
  const [error,setError] = useState('');
  const [revision,setRevision] = useState(0);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/cerebro/acciones-programadas', { headers: { 'X-Cerebro-Key': apiKey } });
      if (!response.ok) throw new Error('No se pudieron consultar las programaciones.');
      const json = await response.json();
      setActions(Array.isArray(json.pendientes) ? json.pendientes : []);
      setError('');
    } catch (caught) { setError(caught.message || 'No se pudieron consultar las programaciones.'); }
  }, [apiKey]);
  useEffect(() => { load(); }, [load, actualizacionId, revision]);
  return <section className="nv-settings-section">
    <div className="nv-settings-section-head"><div><h2>Programaciones pendientes</h2><p>Acciones de WOBi guardadas en la cola del sistema.</p></div><button type="button" onClick={() => setRevision(n => n+1)}>Actualizar ↻</button></div>
    {error && <p role="alert" className="nv-settings-error">{error}</p>}
    {!actions && !error && <p>Cargando programaciones…</p>}
    {actions?.length === 0 && <p>No hay acciones pendientes.</p>}
    {actions?.map(item => <article className="nv-schedule" key={item.id}>
      <span className="nv-schedule-kind">{item.tipo === 'fecha' ? 'Fecha' : 'Condición'}{item.recurrencia ? ` · ${item.recurrencia}` : ''}</span>
      <h3>{item.instruccion || 'Acción sin descripción'}</h3>
      <p>{item.tipo === 'fecha' ? dateLabel(item.fechaObjetivo) : item.condicion || 'Condición pendiente'}</p>
      <small>{item.contexto || 'Origen no especificado'}</small>
    </article>)}
    <p className="nv-settings-note">Para crear o modificar una acción programada, pídeselo a WOBi por Telegram. Esta vista permite comprobar la cola, sin editar instrucciones sensibles desde una sesión web compartida.</p>
    <a href={TELEGRAM_WEB_URL} target="_blank" rel="noopener noreferrer">Abrir Telegram Web ↗</a>
  </section>;
}
export default function SettingsHub({ apiKey, data, onOpen, onRefresh, refreshing, actualizacionId, users, accesses, isAdmin, onLogout, onVerifyAdmin }) {
  const [tab,setTab] = useState('overview');
  const [checking,setChecking] = useState(false);
  const [accessError,setAccessError] = useState('');
  const retry = async () => { setChecking(true); const ok = await onVerifyAdmin(); if (!ok) setAccessError('No se pudo verificar acceso de administración con esta sesión.'); setChecking(false); };
  if (!isAdmin) return <section className="nv-settings-locked"><span aria-hidden="true">⚙</span><h2>Ajustes y administración</h2><p>Esta sesión puede consultar el sistema, pero no administrar usuarios, accesos ni programaciones. Para acceder, inicia sesión con la credencial de administración verificada por el servidor.</p>{accessError && <p role="status" className="nv-settings-error">{accessError}</p>}<button type="button" disabled={checking} onClick={retry}>{checking ? 'Verificando…' : 'Comprobar acceso de nuevo'}</button><button type="button" onClick={onLogout}>Cambiar de sesión</button></section>;
  const broken = (data?.conexiones || []).filter(item => !item.ok);
  return <div className="nv-settings">
    <div className="nv-settings-intro"><span>CONTROL DEL SISTEMA</span><h2>Tu centro de administración</h2><p>Consulta quién tiene acceso, revisa las programaciones y comprueba la salud de las conexiones desde un solo lugar.</p></div>
    <nav className="nv-settings-tabs" aria-label="Secciones de administración">{TABS.map(([id,label]) => <button type="button" key={id} className={tab === id ? 'is-active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {tab === 'overview' && <div className="nv-settings-overview">
      <button type="button" onClick={() => setTab('users')}><span>01 · Personas</span><strong>Usuarios autorizados</strong><small>Roles y accesos de Telegram</small><b aria-hidden="true">↗</b></button>
      <button type="button" onClick={() => setTab('access')}><span>02 · Sesiones</span><strong>Accesos temporales</strong><small>Consulta y revocación</small><b aria-hidden="true">↗</b></button>
      <button type="button" onClick={() => setTab('schedules')}><span>03 · Automatización</span><strong>Programaciones</strong><small>Cola de acciones pendientes</small><b aria-hidden="true">↗</b></button>
      <button type="button" onClick={() => setTab('connections')}><span>04 · Infraestructura</span><strong>{broken.length ? `${broken.length} conexión(es) por revisar` : 'Conexiones'}</strong><small>Estado y último chequeo</small><b aria-hidden="true">↗</b></button>
    </div>}
    {tab === 'users' && <section className="nv-settings-section"><h2>Usuarios y roles</h2><p>Estos roles corresponden a usuarios identificados por Telegram. Cambiar aquí un rol no entrega la clave maestra del panel web.</p>{users}</section>}
    {tab === 'access' && <section className="nv-settings-section"><h2>Sesiones del panel</h2><p>Los accesos temporales se pueden revocar. La clave maestra sigue siendo compartida y requiere rotación para revocarse globalmente.</p>{accesses}</section>}
    {tab === 'schedules' && <ScheduledActions apiKey={apiKey} actualizacionId={actualizacionId} />}
    {tab === 'connections' && <section className="nv-settings-section"><div className="nv-settings-section-head"><div><h2>Conexiones</h2><p>Estado de la última lectura del sistema.</p></div><button type="button" disabled={refreshing} onClick={() => onRefresh('manual')}>{refreshing ? 'Actualizando…' : 'Actualizar ahora ↻'}</button></div>{(data?.conexiones || []).map(item => <div className="nv-settings-connection" key={item.nombre}><span className={item.ok ? 'is-ok' : 'is-broken'}>●</span><strong>{item.nombre}</strong><span>{item.ok ? 'Conectada' : 'Revisar'}</span></div>)}<button type="button" className="nv-settings-open" onClick={() => onOpen('conexiones')}>Abrir diagnóstico detallado ↗</button></section>}
  </div>;
}
