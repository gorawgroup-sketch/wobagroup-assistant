import { Badge } from './SegurosActividad.jsx';
import { SIN_LECTURA, diasLegibles, fechaMadrid, horaMadrid, separarPagos } from './segurosView.mjs';
const importe = pago => Number.isFinite(pago.importe) ? new Intl.NumberFormat('es-ES', { style: 'currency', currency: pago.moneda || 'EUR' }).format(pago.importe) : 'Importe sin dato';
function Pago({ pago }) {
  const evento = pago.evento;
  return <article className="sg-calendar-payment">
    <div className="sg-row"><div><p className="sg-eyebrow">{pago.empresa} · {fechaMadrid(pago.fecha)} · {diasLegibles(pago.diasRestantes)}</p><h4>{pago.concepto}</h4></div><strong className="sg-amount">{importe(pago)}{pago.estimado && <small>estimado</small>}</strong></div>
    <p>Cuenta de cargo: <strong>{pago.cuentaDeCargo || 'sin dato'}</strong> · {pago.forma || 'forma sin dato'}</p>
    <div className="sg-row"><Badge value={{ texto: pago.estado, tono: pago.estado === 'previsto' ? 'neutral' : pago.estado === 'pagado' ? 'success' : 'warning' }} />
      <span className={evento?.estado === 'creado' ? 'sg-calendar-created' : 'sg-muted'}>{evento?.estado === 'creado' ? '✓ En el calendario' : evento?.estado === 'pendiente' ? 'Pendiente · se creará en la próxima pasada de las 08:55 (Madrid)' : evento?.estado === 'no_aplica' ? 'Evento de calendario: no aplica' : SIN_LECTURA}</span></div>
    {evento?.titulo && <p className="sg-muted">{evento.titulo}</p>}{evento?.inicio && <p className="sg-muted">Inicio del evento: {fechaMadrid(evento.inicio)} · {horaMadrid(evento.inicio)} Madrid</p>}
    <p className="sg-muted">Avisos enviados: {pago.avisosEnviados?.length ? pago.avisosEnviados.join(' · ') : 'ninguno registrado'}</p>
  </article>;
}
export default function SegurosCalendario({ estado }) {
  const pagos = separarPagos(estado.calendarioPagos, estado.complementosDisponibles);
  return <section className="sg-section sg-calendar" aria-labelledby="sg-calendar-title">
    <p className="sg-eyebrow">Pagos de la empresa seleccionada</p><h3 id="sg-calendar-title">Calendario de pagos</h3>
    <div className="sg-calendar-account">{estado.calendario ? <><p>{estado.calendario.texto}</p><p>Cuenta del calendario: <strong>{estado.calendario.cuenta || 'sin cuenta configurada'}</strong></p></> : <p>{SIN_LECTURA}</p>}</div>
    {pagos === null ? <p className="sg-muted" role="status">{SIN_LECTURA}</p> : <>
      {pagos.previstos.length ? <div className="sg-payment-list">{pagos.previstos.map(pago => <Pago pago={pago} key={pago.id} />)}</div> : <p className="sg-muted">No hay pagos previstos registrados para esta empresa.</p>}
      {pagos.historia.length > 0 && <details className="sg-details"><summary>Historia de pagos · {pagos.historia.length}</summary>{pagos.historia.map(pago => <Pago pago={pago} key={pago.id} />)}</details>}
    </>}
  </section>;
}
