import { useState } from 'react';
import { SIN_ACTIVIDAD, SIN_LECTURA, agruparBitacora, distintivoResultado, estadoProgramacion, fechaMadrid, horaMadrid, proximaLegible } from './segurosView.mjs';

export function Badge({ value }) { return <span className={`sg-badge sg-badge--${value.tono}`}>{value.texto}</span>; }
function Avisos({ entrada }) {
  return <div className="sg-avisos">{entrada.avisos?.map((aviso, i) => <article className="sg-aviso" key={i}>
    <div className="sg-row"><strong>{aviso.titulo || 'Aviso de Telegram'}</strong><span className={`sg-badge sg-badge--${aviso.entregado === false ? 'danger' : 'neutral'}`}>{aviso.entregado === false ? 'No llegó a Telegram' : aviso.entregado === true ? 'Aceptado por Telegram' : 'Entrega sin confirmar'}</span></div>
    <small>Hora de ejecución: {horaMadrid(entrada.cuando)} · Madrid. Hora individual de entrega no disponible.</small>
    <p className="sg-exact-text">{aviso.texto}</p>
  </article>)}</div>;
}
export function SegurosActividad({ estado }) {
  const [tarea, setTarea] = useState('');
  const [soloAvisos, setSoloAvisos] = useState(false);
  const grupos = agruparBitacora(estado.bitacora, { tarea, soloAvisos }, estado.complementosDisponibles);
  const tareas = [...new Map([...(estado.programacion || []).map(t => [t.id, t.nombre]), ...(estado.bitacora || []).map(t => [t.tarea, t.etiqueta])]).entries()];
  return <section className="sg-section sg-activity" aria-labelledby="sg-activity-title">
    <div className="sg-section-heading"><div><p className="sg-eyebrow">Grupo completo · hora de Madrid</p><h3 id="sg-activity-title">Actividad de Wobi Seguros</h3></div><span className="sg-mode">Solo lectura</span></div>
    <div className="sg-filters"><label>Tarea <select value={tarea} onChange={e => setTarea(e.target.value)}><option value="">Todas las tareas</option>{tareas.map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}</select></label>
      <label className="sg-checkbox"><input type="checkbox" checked={soloAvisos} onChange={e => setSoloAvisos(e.target.checked)} />Solo avisos · Alertas que recibí</label></div>
    {grupos === null ? <p className="sg-muted" role="status">{SIN_LECTURA}</p>
      : !estado.bitacora.length ? <p className="sg-muted">{SIN_ACTIVIDAD}</p>
      : !grupos.length ? <p className="sg-muted">{soloAvisos ? 'No hay avisos registrados con este filtro.' : 'No hay actividad con este filtro.'}</p>
      : grupos.map(grupo => <div className="sg-day" key={grupo.dia}><h4>{fechaMadrid(grupo.dia)}</h4><ol className="sg-timeline">{grupo.entradas.map(entrada => <li key={entrada.id}>
        <details className="sg-entry" open={soloAvisos || undefined}>
          <summary><time dateTime={entrada.cuando}>{horaMadrid(entrada.cuando)}</time><strong>{entrada.etiqueta}</strong><Badge value={distintivoResultado(entrada.resultado)} /><span className="sg-entry-summary">{entrada.resumen}</span></summary>
          <div className="sg-entry-body"><Avisos entrada={entrada} />
            {!!entrada.eventos?.length && <div><h5>Eventos de calendario</h5><ul>{entrada.eventos.map((evento, i) => <li key={i}><strong>{evento.accion === 'creado' ? 'Creado' : 'Retirado'}</strong> · {evento.titulo}<p>{fechaMadrid(evento.inicio)} · {horaMadrid(evento.inicio)} Madrid</p></li>)}</ul></div>}
            {!!entrada.notas?.length && <div><h5>Notas</h5>{entrada.notas.map((nota, i) => <p className="sg-exact-text" key={i}>{nota}</p>)}</div>}
            {!entrada.avisos?.length && !entrada.eventos?.length && !entrada.notas?.length && <p className="sg-muted">Esta ejecución no registró avisos, eventos ni notas adicionales.</p>}
          </div>
        </details>
      </li>)}</ol></div>)}
  </section>;
}
export function SegurosProgramacion({ programacion }) {
  return <section className="sg-section sg-schedule" aria-labelledby="sg-schedule-title">
    <p className="sg-eyebrow">Grupo completo · hora de Madrid</p><h3 id="sg-schedule-title">Cuándo trabaja</h3>
    {!Array.isArray(programacion) ? <p className="sg-muted">{SIN_LECTURA}</p> : programacion.map(tarea => <article className={`sg-task sg-task--${tarea.estado}`} key={tarea.id}>
      <div className="sg-row"><h4>{tarea.nombre}</h4><Badge value={estadoProgramacion(tarea.estado)} /></div>
      <p className="sg-task-when">{tarea.cuando}</p><p>{tarea.queHace}</p><p className="sg-muted">Avisa: {tarea.cuandoAvisa}</p>
      {tarea.conIA && <span className="sg-badge sg-badge--warning">Usa IA al preguntarle</span>}
      <div className="sg-task-times"><div><h5>Próxima</h5><p>{tarea.estado === 'bajo_demanda' ? 'Cuando se le pregunta' : proximaLegible(tarea.proxima)}</p></div>
        <div><h5>Última constancia</h5>{tarea.ultima ? <><p>{fechaMadrid(tarea.ultima.cuando)} · {horaMadrid(tarea.ultima.cuando)} <Badge value={distintivoResultado(tarea.ultima.resultado)} /></p><p>{tarea.ultima.resumen}</p></> : <p className="sg-muted">{tarea.estado === 'sin_lectura' ? SIN_LECTURA : 'Aún sin constancia registrada'}</p>}</div></div>
    </article>)}
  </section>;
}
