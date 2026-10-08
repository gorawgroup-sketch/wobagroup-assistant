export const SIN_LECTURA = 'Sin lectura actual';

export function distintivoPoliza(poliza = {}) {
  if (poliza.estado === 'no_contratada') return { texto: 'No contratada', tono: 'neutral' };
  if (poliza.estado === 'vencida') return { texto: 'Vencida', tono: 'danger' };
  if (poliza.estado === 'pendiente_confirmacion') return { texto: 'En hold / por confirmar', tono: 'warning' };
  const pagos = {
    pagado: { texto: 'Pagado', tono: 'success' },
    pendiente: { texto: 'Pendiente', tono: 'warning' },
    sin_confirmar: { texto: 'Sin confirmar', tono: 'warning' },
    no_aplica: { texto: 'No aplica', tono: 'neutral' },
  };
  return pagos[poliza.estadoPago] || { texto: poliza.estadoPago || 'Sin dato', tono: 'neutral' };
}

export function separarNotas(notas = '') {
  const [actual = '', ...historia] = String(notas).split(' || ');
  return { actual: actual.trim(), historia: historia.join(' || ').trim() };
}

export function agruparMemoria(memoria) {
  if (!Array.isArray(memoria)) return null;
  return Object.groupBy ? Object.groupBy(memoria, item => item.tipo || 'otro')
    : memoria.reduce((grupos, item) => {
      (grupos[item.tipo || 'otro'] ||= []).push(item);
      return grupos;
    }, {});
}

export function agruparProximos(proximos) {
  if (!Array.isArray(proximos)) return [];
  const grupos = [];
  for (const evento of proximos) {
    const clave = evento.polizaId || `${evento.empresa}:${evento.fecha}:${evento.texto}`;
    // Una renovación puede producir dos hitos a 1–2 días; otra cuota de la misma póliza
    // meses después es un hito distinto y debe permanecer en su tramo temporal.
    let grupo = grupos.find(g => g.polizaId === clave && g.eventos.some(e => {
      const diferencia = Math.abs(Date.parse(e.fecha) - Date.parse(evento.fecha));
      return Number.isFinite(diferencia) && diferencia <= 2 * 24 * 60 * 60 * 1000;
    }));
    if (!grupo) {
      grupo = { key: `${clave}:${evento.fecha}`, polizaId: clave, empresa: evento.empresa, eventos: [], cercano: false };
      grupos.push(grupo);
    }
    grupo.eventos.push(evento);
    grupo.cercano ||= Number.isFinite(Number(evento.diasRestantes)) && Number(evento.diasRestantes) <= 60;
  }
  return grupos;
}

export function lecturaDisponible(valor, complementosDisponibles) {
  return complementosDisponibles === false || valor == null ? SIN_LECTURA : null;
}

export function revisionAntigua(fecha, ahora = Date.now()) {
  const leida = Date.parse(fecha || '');
  return Number.isFinite(leida) && ahora - leida > 24 * 60 * 60 * 1000;
}
