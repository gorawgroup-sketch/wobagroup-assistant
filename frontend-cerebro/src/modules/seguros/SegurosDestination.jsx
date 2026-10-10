import { SegurosActividad } from './SegurosActividad.jsx';
import { segurosDestination } from './destinations.mjs';
import { diasLegibles, SIN_LECTURA } from './segurosView.mjs';
import './SegurosPanel.css';

const amount = p => p.prima == null || p.prima === '' ? 'Importe sin dato' : `${p.prima}${p.moneda ? ` ${p.moneda}` : ''} · prima registrada`;
export default function SegurosDestination({ estado, sectionId, companyId, companyName, onFull }) {
  const view = segurosDestination(estado, sectionId, companyId);
  if (!view) return <p role="alert">Destino de Seguros no disponible.</p>;
  return <div className="sg-panel sg-destination" data-section={sectionId}>
    <section className="sg-section" aria-labelledby="sg-destination-title">
      <div className="sg-section-heading"><div><p className="sg-eyebrow">{view.scope === 'group' ? 'Grupo completo · no se atribuye a una compañía' : `Compañía · ${companyName}`}</p><h2 id="sg-destination-title">{view.title}</h2></div><span className="sg-mode">Solo lectura</span></div>
      <p className="sg-muted">{sectionId === 'pagos_pendientes' ? 'Pólizas cuyo pago sigue pendiente o sin confirmar en la última lectura. La prima registrada no demuestra un cargo bancario ni un pago realizado.' : sectionId === 'proximas_renovaciones' ? 'Alertas de renovación y vencimientos del horizonte recibido. Esta vista excluye eventos de pago; no aplica fechas adicionales.' : 'Constancias de lo que Wobi Seguros hizo para el grupo completo.'}</p>
      <button className="sg-quiet" type="button" onClick={onFull}>Ver Control de seguros completo</button>
    </section>
    {sectionId === 'actividad' ? <SegurosActividad estado={view.activity} /> : <section className="sg-section" aria-label={view.title}>
      {sectionId === 'proximas_renovaciones' && (!view.alertsAvailable || !view.upcomingAvailable) && <p className="sg-muted" role="status">{SIN_LECTURA} de {!view.alertsAvailable ? 'alertas de renovación' : 'vencimientos del horizonte'}. {view.items?.length ? 'Se muestra la parte disponible.' : ''}</p>}
      {view.items === null ? <p className="sg-muted" role="status">{SIN_LECTURA}</p> : view.items.length === 0 ? <p className="sg-muted">{sectionId === 'pagos_pendientes' ? 'No hay pagos pendientes de confirmación en la lectura de esta compañía.' : view.alertsAvailable && view.upcomingAvailable ? 'No hay renovaciones ni vencimientos en el horizonte recibido de esta compañía.' : 'No hay resultados en la parte disponible de la lectura.'}</p> : <div className="sg-policy-grid">{view.items.map(p => <article className="sg-policy" key={sectionId === 'pagos_pendientes' ? p.id : `${p.polizaId}:${p.fecha}`}>
        <div className="sg-policy-head"><h3>{p.tipoCobertura || p.texto || 'Póliza sin nombre'}</h3><span className={`sg-badge sg-badge--${sectionId === 'pagos_pendientes' || p.urgent ? 'warning' : 'neutral'}`}>{sectionId === 'pagos_pendientes' ? p.estadoPago === 'pendiente' ? 'Pago pendiente' : 'Pago sin confirmar' : p.urgent ? 'Alerta de renovación' : 'Vencimiento próximo'}</span></div>
        {sectionId === 'pagos_pendientes' ? <><p>{p.aseguradora}</p><p>{amount(p)}</p>{p.notas && <details className="sg-details"><summary>Ver constancia y contexto</summary><p className="sg-exact-text">{p.notas}</p></details>}</> : <p>{p.fecha || 'Fecha sin dato'} · {p.diasRestantes == null ? 'Plazo sin dato' : diasLegibles(p.diasRestantes)}</p>}
      </article>)}</div>}
    </section>}
  </div>;
}
