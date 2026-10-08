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

export const SIN_ACTIVIDAD = 'Aún sin actividad registrada: la bitácora empezó el 08-10-2026';
const zonaMadrid = 'Europe/Madrid';
export function diaMadrid(valor) {
  const fecha = new Date(valor);
  if (!Number.isFinite(fecha.getTime())) return null;
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: zonaMadrid, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(fecha);
  const parte = tipo => partes.find(p => p.type === tipo).value;
  return `${parte('year')}-${parte('month')}-${parte('day')}`;
}
export function horaMadrid(valor) {
  const fecha = new Date(valor);
  return valor && Number.isFinite(fecha.getTime())
    ? new Intl.DateTimeFormat('es-ES', { timeZone: zonaMadrid, hour: '2-digit', minute: '2-digit' }).format(fecha) : SIN_LECTURA;
}
export function fechaMadrid(valor) {
  const fecha = new Date(valor?.length === 10 ? `${valor}T12:00:00Z` : valor);
  return valor && Number.isFinite(fecha.getTime())
    ? new Intl.DateTimeFormat('es-ES', { timeZone: zonaMadrid, day: 'numeric', month: 'long', year: 'numeric' }).format(fecha) : SIN_LECTURA;
}
export function proximaLegible(valor, ahora = Date.now()) {
  if (!valor) return SIN_LECTURA;
  const dia = diaMadrid(valor);
  if (!dia) return SIN_LECTURA;
  // Día civil de Madrid: sumar al mediodía evita saltos al cambiar el horario de verano.
  const hoy = diaMadrid(ahora);
  const manana = new Date(`${hoy}T12:00:00Z`); manana.setUTCDate(manana.getUTCDate() + 1);
  return `${dia === hoy ? 'hoy' : dia === diaMadrid(manana) ? 'mañana' : fechaMadrid(valor)} ${horaMadrid(valor)}`;
}
export function distintivoResultado(resultado) {
  return ({ sin_novedades: { texto: 'Sin novedades', tono: 'neutral' }, con_novedades: { texto: 'Con novedades', tono: 'success' }, con_advertencias: { texto: 'Con advertencias', tono: 'warning' }, error: { texto: 'Error', tono: 'danger' } })[resultado] || { texto: resultado || SIN_LECTURA, tono: 'neutral' };
}
export function estadoProgramacion(estado) {
  return ({ al_dia: { texto: 'Al día', tono: 'success' }, retrasada: { texto: 'Retrasada · su última cita no dejó constancia', tono: 'danger' }, sin_registro: { texto: 'Aún sin constancia: la bitácora es nueva', tono: 'neutral' }, sin_lectura: { texto: SIN_LECTURA, tono: 'neutral' }, bajo_demanda: { texto: 'Cuando se le pregunta', tono: 'neutral' } })[estado] || { texto: SIN_LECTURA, tono: 'neutral' };
}
export function agruparBitacora(bitacora, { tarea = '', soloAvisos = false } = {}, complementosDisponibles) {
  if (lecturaDisponible(bitacora, complementosDisponibles)) return null;
  const entradas = bitacora.filter(e => (!tarea || e.tarea === tarea) && (!soloAvisos || e.avisos?.length))
    .slice().sort((a, b) => Date.parse(b.cuando) - Date.parse(a.cuando));
  const grupos = new Map();
  for (const entrada of entradas) {
    const dia = diaMadrid(entrada.cuando) || 'Sin fecha';
    if (!grupos.has(dia)) grupos.set(dia, { dia, entradas: [] });
    grupos.get(dia).entradas.push(entrada);
  }
  return [...grupos.values()];
}
export function diasLegibles(dias) {
  if (dias == null || !Number.isFinite(Number(dias))) return 'sin fecha relativa';
  return Number(dias) === 0 ? 'hoy' : Number(dias) < 0 ? `vencido hace ${Math.abs(Number(dias))} días` : `en ${dias} días`;
}
export function mensajeRevision(revision, complementosDisponibles) {
  return complementosDisponibles === false ? SIN_LECTURA : revision == null ? 'Aún sin revisión registrada' : null;
}
export function ordenarDocumentos(documentos) {
  return documentos == null ? null : documentos.slice().sort((a, b) => String(b.fechaDocumento || '').localeCompare(String(a.fechaDocumento || '')));
}
export function separarPagos(pagos, complementosDisponibles) {
  if (lecturaDisponible(pagos, complementosDisponibles)) return null;
  const ordenados = pagos.slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { previstos: ordenados.filter(p => p.estado === 'previsto'), historia: ordenados.filter(p => p.estado !== 'previsto') };
}
