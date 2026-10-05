import { useEffect, useState } from 'react';
import TelegramHandoff from '../nucleo/TelegramHandoff.jsx';
import { agruparMemoria, agruparProximos, distintivoPoliza, lecturaDisponible, revisionAntigua, separarNotas } from './segurosView.mjs';
import './SegurosPanel.css';

const EMPRESAS = ['WOBA', 'EWORKS', 'Footprint'];
const PREGUNTAS = [
  '¿Tenemos algo pendiente de seguros?',
  '¿Cuándo toca pagar lo siguiente?',
  '¿Qué cubre la RC de WOBA?',
  '¿Qué le falta pedirle a Acodrid?',
];
const fechaLegible = valor => {
  if (!valor) return 'sin fecha';
  const fecha = new Date(valor);
  return Number.isFinite(fecha.getTime())
    ? fecha.toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : valor;
};
const money = poliza => {
  if (!poliza?.prima) return null;
  const numero = Number(String(poliza.prima).replace(',', '.'));
  return Number.isFinite(numero) && poliza.moneda === 'EUR'
    ? new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(numero)
    : `${poliza.prima}${poliza.moneda ? ` ${poliza.moneda}` : ''}`;
};
const empty = (texto, unavailable) => <p className="sg-muted">{unavailable || texto}</p>;

function PolicyCard({ poliza, documentos, complementosDisponibles, puedeArreglar, confirmandoId, marcandoId, onMarcar, onCancelar }) {
  const badge = distintivoPoliza(poliza);
  const notas = separarNotas(poliza.notas);
  const archivos = Array.isArray(documentos) ? documentos.filter(d => d.polizaId === poliza.id) : null;
  const permitePago = poliza.estadoPago === 'pendiente' || poliza.estadoPago === 'sin_confirmar';
  return <article className="sg-policy">
    <div className="sg-policy-head">
      <div><h4>{poliza.tipoCobertura || 'Póliza sin nombre'}</h4><p>{poliza.aseguradora || 'Aseguradora sin confirmar'}{poliza.numeroPoliza ? ` · ${poliza.numeroPoliza}` : ''}</p></div>
      <span className={`sg-badge sg-badge--${badge.tono}`}>{badge.texto}</span>
    </div>
    <div className="sg-policy-meta">{money(poliza) && <span>Prima: {money(poliza)}</span>}{poliza.fechaVencimiento && <span>Vence: {poliza.fechaVencimiento}</span>}</div>
    {notas.actual && <p className="sg-current">{notas.actual}</p>}
    {notas.historia && <details className="sg-details"><summary>Ver historia</summary><p>{notas.historia}</p></details>}
    <div className="sg-documents">
      <h5>Documentos leídos</h5>
      {lecturaDisponible(archivos, complementosDisponibles)
        ? empty('', lecturaDisponible(archivos, complementosDisponibles))
        : archivos.length ? archivos.map((d, i) => <div className="sg-document" key={`${d.enlace}-${i}`}>
          <strong>{d.nombre}</strong><span>{d.tipo}</span>
          <span>Vigencia: {d.vigencia || 'sin dato'} · Prima: {d.prima || 'sin dato'}</span>
          <span>Capital: {d.capital || 'sin dato'}</span>
          {d.resumen && <><p>{d.resumen.length > 280 ? `${d.resumen.slice(0, 277).trimEnd()}…` : d.resumen}</p>
            {d.resumen.length > 280 && <details className="sg-details"><summary>Ver resumen completo</summary><p>{d.resumen}</p></details>}</>}
          {d.enlace && <a href={d.enlace} target="_blank" rel="noopener noreferrer">Abrir en Drive ↗</a>}
        </div>) : empty('Ningún documento leído para esta póliza.')}
    </div>
    {permitePago && (puedeArreglar
      ? <div className="sg-action-row"><button type="button" disabled={!!marcandoId} onClick={() => onMarcar(poliza.id)}>{marcandoId === poliza.id ? 'Marcando…' : confirmandoId === poliza.id ? 'Confirmar pago' : 'Marcar como pagado'}</button>{confirmandoId === poliza.id && marcandoId !== poliza.id && <button type="button" className="sg-quiet" onClick={onCancelar}>Cancelar</button>}</div>
      : <p className="sg-muted">Requiere administración para confirmar el pago.</p>)}
  </article>;
}

export default function SegurosPanel({ apiKey, puedeArreglar, estado, onRefresh }) {
  const [polizasLocal, setPolizasLocal] = useState(null);
  const [confirmandoId, setConfirmandoId] = useState(null);
  const [marcandoId, setMarcandoId] = useState(null);
  const [error, setError] = useState('');
  const [pregunta, setPregunta] = useState(null);
  useEffect(() => { setPolizasLocal(null); setConfirmandoId(null); }, [estado]);
  if (!estado) return <p className="sg-muted">Cargando registro de seguros…</p>;

  const polizas = polizasLocal || estado.polizas || [];
  const resumen = estado.resumen || {};
  const pagos = estado.pagosSinConfirmar || [];
  const revision = estado.vigilante?.ultimaRevision;
  const complementosDisponibles = estado.complementosDisponibles;
  const proximos = agruparProximos(estado.proximos);
  const cercanos = proximos.filter(g => g.cercano);
  const posteriores = proximos.filter(g => !g.cercano);
  const memoria = agruparMemoria(estado.memoria);
  const atencion = Boolean(pagos.length || revision?.enTransito?.length || estado.esperandoACarlos?.length || revision?.advertencias?.length || complementosDisponibles === false);

  const marcarPagado = async id => {
    if (!apiKey || marcandoId) return;
    if (confirmandoId !== id) { setConfirmandoId(id); return; }
    setMarcandoId(id);
    setError('');
    try {
      const res = await fetch('/api/cerebro/seguros/marcar-pago', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cerebro-Key': apiKey },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error('No se pudo marcar la póliza como pagada.');
      const json = await res.json();
      if (json?.poliza) setPolizasLocal(prev => (prev || estado.polizas || []).map(p => p.id === id ? json.poliza : p));
      setConfirmandoId(null);
      await onRefresh('manual');
    } catch {
      setError('No se pudo marcar la póliza como pagada. No se cambió el registro; vuelve a intentarlo.');
    } finally { setMarcandoId(null); }
  };
  const hito = grupo => <li key={grupo.key} className={grupo.cercano ? 'sg-hito sg-hito--soon' : 'sg-hito'}>
    <strong>{grupo.empresa} · {grupo.eventos[0]?.texto?.replace(/^(Vence|Pago)\s*/i, '') || grupo.polizaId}</strong>
    <ul>{grupo.eventos.map((evento, i) => <li key={i}>{evento.tipo === 'pago' ? 'Pago' : 'Vencimiento'} · {evento.fecha} · {evento.diasRestantes <= 0 ? 'vencido' : `en ${evento.diasRestantes} días`}</li>)}</ul>
  </li>;

  return <div className="sg-panel">
    <div className="sg-overview" aria-label="Resumen de seguros">
      {[['Pólizas vigentes', resumen.vigentes, 'success'], ['Pagos sin confirmar', resumen.sinConfirmarPago, 'warning'], ['En hold / por confirmar', resumen.porConfirmarOEnHold, 'warning'], ['Vencidas', resumen.vencidas, 'danger']].map(([label, value, tone]) =>
        <div className={`sg-stat sg-stat--${tone}`} key={label}><span>{label}</span><strong>{value ?? '—'}</strong></div>)}
    </div>
    {atencion && <section className="sg-section sg-attention" aria-labelledby="sg-attention-title">
      <h3 id="sg-attention-title">Atención ahora</h3>
      {pagos.map(p => <div className="sg-alert" key={p.id}><strong>Pago sin confirmar · {p.empresa}</strong><p>{p.tipoCobertura} · {money(p) || 'importe sin dato'}</p></div>)}
      {!!revision?.enTransito?.length && <div className="sg-alert"><strong>Cargos en tránsito · grupo completo</strong>{revision.enTransito.map((texto, i) => <p key={i}>{texto}{/aún no confirmado por el banco/i.test(texto) ? '' : ' · aún no confirmado por el banco'}</p>)}</div>}
      {lecturaDisponible(estado.esperandoACarlos, complementosDisponibles)
        ? empty('', lecturaDisponible(estado.esperandoACarlos, complementosDisponibles))
        : estado.esperandoACarlos.map(e => <div className="sg-alert" key={e.id}><strong>Espera a Carlos · grupo completo · {e.diasEsperando} días</strong><p>{e.texto}</p></div>)}
      {!!revision?.advertencias?.length && <div className="sg-alert"><strong>Revisión incompleta · grupo completo</strong>{revision.advertencias.map((texto, i) => <p key={i}>{texto}</p>)}</div>}
    </section>}
    <section className="sg-section" aria-labelledby="sg-upcoming-title">
      <h3 id="sg-upcoming-title">Próximos pagos y vencimientos</h3>
      {!proximos.length ? empty('Ningún pago ni vencimiento anotado.') : <>
        {cercanos.length > 0 && <><p className="sg-eyebrow">En los próximos 60 días</p><ul className="sg-hitos">{cercanos.map(hito)}</ul></>}
        {posteriores.length > 0 && <details className="sg-details"><summary>Próximos 12 meses · {posteriores.length} póliza(s)</summary><ul className="sg-hitos">{posteriores.map(hito)}</ul></details>}
      </>}
    </section>
    <section className="sg-section" aria-labelledby="sg-policies-title">
      <h3 id="sg-policies-title">Pólizas</h3>
      {EMPRESAS.map(empresa => {
        const items = polizas.filter(p => p.empresa === empresa);
        return items.length ? <details className="sg-company" key={empresa} open={EMPRESAS.filter(e => polizas.some(p => p.empresa === e)).length === 1}>
          <summary>{empresa} · {items.length} póliza(s)</summary>
          <div className="sg-policy-grid">{items.map(p => <PolicyCard key={p.id} poliza={p} documentos={estado.documentos} complementosDisponibles={complementosDisponibles} puedeArreglar={puedeArreglar} confirmandoId={confirmandoId} marcandoId={marcandoId} onMarcar={marcarPagado} onCancelar={() => setConfirmandoId(null)} />)}</div>
        </details> : null;
      })}
      {!polizas.length && empty('No hay pólizas registradas para esta empresa.')}
      {error && <p role="alert" className="sg-error">{error}</p>}
      {estado.linkRegistro && <a className="sg-record-link" href={estado.linkRegistro} target="_blank" rel="noopener noreferrer">Abrir el registro conjunto ↗</a>}
    </section>
    <details className="sg-section sg-details sg-memory">
      <summary>Lo que Wobi Seguros recuerda · grupo completo</summary>
      {lecturaDisponible(estado.memoria, complementosDisponibles)
        ? empty('', lecturaDisponible(estado.memoria, complementosDisponibles))
        : Object.entries(memoria).map(([tipo, entradas]) => <div key={tipo}><h4>{tipo.replaceAll('_', ' ')}</h4><ul>{entradas.map(e => <li key={e.id}><p>{e.texto}</p><small>{e.fuente} · {e.fecha}</small></li>)}</ul></div>)}
    </details>
    <section className="sg-section sg-watch" aria-label="Vigilante de seguros">
      <strong>Vigilante · grupo completo</strong>
      <p>Horarios: {(estado.vigilante?.horarios || []).join(' y ') || 'sin horario informado'}</p>
      {lecturaDisponible(revision, complementosDisponibles)
        ? empty('', lecturaDisponible(revision, complementosDisponibles))
        : <p>Última revisión del vigilante: {fechaLegible(revision.fecha)}{revisionAntigua(revision.fecha) ? ' · hace más de 24 h; comprobar actualización' : ''}</p>}
    </section>
    <section className="sg-section sg-questions" aria-label="Preguntar a Wobi Seguros">
      <h3>Preguntar a Wobi Seguros</h3><div>{PREGUNTAS.map(texto => <button key={texto} type="button" onClick={() => setPregunta(texto)}>{texto} ↗</button>)}</div>
    </section>
    {pregunta && <TelegramHandoff question={pregunta} onClose={() => setPregunta(null)} />}
  </div>;
}
