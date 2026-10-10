const COMPANIES = new Set(['WOBA', 'EWORKS', 'Footprint']);
export const SEGUROS_SECTIONS = Object.freeze({
  pagos_pendientes: { title: 'Pagos pendientes de seguros', scope: 'company' },
  proximas_renovaciones: { title: 'Próximas renovaciones de seguros', scope: 'company' },
  actividad: { title: 'Actividad de Wobi Seguros', scope: 'group' },
});
// Only received facts: no inferred payment state, dates, amounts or company attribution.
export function segurosDestination(estado, sectionId, companyId) {
  const section = SEGUROS_SECTIONS[sectionId];
  if (!section || !COMPANIES.has(companyId)) return null;
  const own = list => Array.isArray(list) ? list.filter(p => p.empresa === companyId) : null;
  if (sectionId === 'actividad') return { ...section, activity: estado || { bitacora: null, programacion: null }, items: null };
  if (sectionId === 'pagos_pendientes') return { ...section, items: own(estado?.pagosSinConfirmar) };
  // Near-term alerts and the longer horizon are different source lists. Preserve unknown
  // independently, deduplicate the same policy/date, and exclude payment events.
  const alerts = own(estado?.proximasARenovar);
  const upcoming = own(estado?.proximos)?.filter(p => p.tipo === 'vencimiento') ?? null;
  const rows = new Map();
  for (const p of upcoming || []) rows.set(`${p.polizaId}:${p.fecha}`, { ...p, urgent: false });
  for (const p of alerts || []) rows.set(`${p.id}:${p.fechaVencimiento}`, {
    polizaId: p.id, empresa: p.empresa, fecha: p.fechaVencimiento,
    diasRestantes: p.diasRestantes, texto: `${p.tipoCobertura}${p.aseguradora ? ` · ${p.aseguradora}` : ''}`, urgent: true,
  });
  return { ...section, items: alerts === null && upcoming === null ? null : [...rows.values()].sort((a,b) => String(a.fecha || '').localeCompare(String(b.fecha || ''))), alertsAvailable: alerts !== null, upcomingAvailable: upcoming !== null };
}
