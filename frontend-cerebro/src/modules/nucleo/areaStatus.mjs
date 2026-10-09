// Read-only presentation of capability and current source reports; no access decisions.
export function areaStatus(area, data) {
  if (area.stage === 'planned') return { id: 'planned', label: 'Pendiente de conectar', flow: .12 };
  const modules = area.modules.filter(module => module.id !== 'strategic_planning');
  const prefixes = modules.map(module => module.id === 'calendario' ? 'crm' : module.id);
  const sources = (data?.fuentes || []).filter(source => prefixes.some(prefix => source.fuente === prefix || source.fuente.startsWith(`${prefix}.`)));
  if (sources.some(source => !source.ok)) return { id: 'incident', label: 'Lectura con incidencias', flow: .35 };
  const verified = prefixes.length && prefixes.every(prefix => sources.some(source => source.ok && (source.fuente === prefix || source.fuente.startsWith(`${prefix}.`))));
  if (!verified) return { id: 'checking', label: 'Conexión pendiente de verificar', flow: .25 };
  return area.stage === 'documents' ? { id: 'documents', label: 'Consulta documental disponible', flow: .65 }
    : { id: 'available', label: 'Herramientas conectadas', flow: 1 };
}
