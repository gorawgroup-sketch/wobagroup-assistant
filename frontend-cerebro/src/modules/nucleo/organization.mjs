// Navigation metadata only. Selection is context for a request, never an access grant.
// Keep legal records, personal identities and corporate documents on the server.
export const COMPANIES = Object.freeze([
  { id: 'WOBA', name: 'WOBA', detail: 'Business Atelier Europa', mark: 'W' },
  { id: 'Footprint', name: 'Footprint Global', detail: 'Compañía gestionada', mark: 'F' },
  { id: 'EWORKS', name: 'eWorks', detail: 'Compañía gestionada', mark: 'e' },
]);

export const AREAS = Object.freeze([
  { id: 'finance', name: 'Finanzas', short: 'Finanzas', symbol: '01', stage: 'available', description: 'Contabilidad, conciliaciones, gastos y facturas. Accede a las herramientas actuales o consulta a WOBi.', modules: [{ id: 'holded', name: 'Contabilidad en Holded' }, { id: 'cashflow', name: 'Tesorería y cashflow' }, { id: 'fiscal', name: 'Fiscalidad' }] },
  { id: 'operations', name: 'Operaciones y procesos', short: 'Operaciones', symbol: '02', stage: 'available', description: 'Documentación, correo y procesos de trabajo en un mismo espacio.', modules: [{ id: 'drive', name: 'Documentos en Drive' }, { id: 'correo', name: 'Correo' }, { id: 'conocimiento', name: 'Conocimiento' }, { id: 'calendario', name: 'Calendario' }] },
  { id: 'insurance', name: 'Seguros', short: 'Seguros', symbol: '03', stage: 'available', description: 'Consulta pólizas, vencimientos y el estado del módulo de seguros.', modules: [{ id: 'seguros', name: 'Control de seguros' }] },
  { id: 'corporate', name: 'Corporate', short: 'Corporate', symbol: '04', stage: 'documents', description: 'Localiza documentos corporativos en Drive con WOBi. El mapa de relaciones societarias está pendiente de integrar.', modules: [{ id: 'drive', name: 'Documentación corporativa' }] },
  { id: 'people', name: 'Gestión humana', short: 'Personas', symbol: '05', stage: 'planned', description: 'Espacio previsto para personas y procesos de gestión humana. Todavía sin agente especializado.', modules: [] },
  { id: 'marketing', name: 'Marketing y social media', short: 'Marketing', symbol: '06', stage: 'planned', description: 'Campañas y seguimiento de redes de cada compañía. Las cuentas sociales todavía no están integradas.', modules: [] },
  { id: 'commercial', name: 'Ventas y clientes', short: 'Comercial', symbol: '07', stage: 'planned', description: 'Espacio para ventas y clientes. El programa externo de generación de leads de eWorks está pendiente de integración.', modules: [] },
  { id: 'procurement', name: 'Compras y proveedores', short: 'Compras', symbol: '08', stage: 'planned', description: 'Espacio reservado para compras, proveedores y sus flujos de aprobación.', modules: [] },
  { id: 'compliance', name: 'Compliance', short: 'Compliance', symbol: '09', stage: 'planned', description: 'Espacio previsto para cumplimiento normativo en España y su futuro agente especializado.', modules: [] },
  { id: 'quality', name: 'Calidad y medioambiente', short: 'ISO', symbol: '10', stage: 'planned', description: 'Espacio previsto para gestionar ISO 9001 y 14001, inicialmente en WOBA. El agente ISO todavía no está integrado.', modules: [] },
  { id: 'technology', name: 'Tecnología y seguridad', short: 'Tecnología', symbol: '11', stage: 'planned', description: 'Espacio reservado para tecnología y seguridad de la información. El futuro agente de seguridad se integrará aquí.', modules: [] },
]);

export const STAGES = { available: 'Herramientas disponibles', documents: 'Consulta documental', planned: 'Previsto' };
export const companyById = id => COMPANIES.find(company => company.id === id) || COMPANIES[0];
export const areaById = id => AREAS.find(area => area.id === id) || null;

