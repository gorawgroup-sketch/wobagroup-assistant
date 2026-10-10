import { AREAS, COMPANIES } from '../nucleo/organization.mjs';

// One metadata source: registering an area/module makes it discoverable here.
// This catalogue neither grants access nor asserts current source freshness.
export function buildCapabilities(areas = AREAS) {
  const entries = areas.flatMap(area => [
    { id: `area:${area.id}`, label: area.name, description: area.description,
      status: area.stage === 'planned' ? 'planned' : 'available',
      target: { kind: 'area', id: area.id }, companies: COMPANIES.map(c => c.id) },
    ...area.modules.flatMap(module => [
      { id: `module:${area.id}:${module.id}`,
        label: module.name, description: area.description, status: 'available',
        target: { kind: 'module', id: module.id }, companies: COMPANIES.map(c => c.id) },
      // Destinos precisos (secciones) de un módulo: `registered` = registrado pero sin vista implementada todavía; `scope: 'group'` =
      // sus datos son del grupo completo y no se atribuyen a una sola compañía.
      ...(module.sections || []).map(section => ({ id: `section:${area.id}:${module.id}:${section.id}`,
        label: section.name, description: section.description || area.description,
        status: section.implemented === true ? 'available' : 'registered', scope: section.scope === 'group' ? 'group' : 'company',
        target: { kind: 'section', area: area.id, module: module.id, id: section.id }, companies: COMPANIES.map(c => c.id) })),
    ]),
  ]);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Capacidad duplicada');
  return entries;
}

// Treat model output as untrusted. Only registered destinations can be proposed.
// Backend permission checks remain mandatory before any data access.
export function validateDestination(proposal, capabilities = buildCapabilities()) {
  if (!proposal || typeof proposal !== 'object') return null;
  const entry = capabilities.find(item => item.id === proposal.capabilityId);
  if (!entry || !entry.companies.includes(proposal.companyId)) return null;
  // Exact sections/filters are not yet wired. Never silently drop requested filters.
  if (proposal.section != null || proposal.filters != null) return null;
  return { capabilityId: entry.id, companyId: proposal.companyId,
    target: { ...entry.target }, status: entry.status, ...(entry.scope ? {scope:entry.scope} : {}) };
}
