// Navigation metadata only. Selection is context for a request, never an access grant.
// Keep legal records, personal identities and corporate documents on the server.
export const COMPANIES = Object.freeze([
  { id: 'WOBA', name: 'WOBA', detail: 'Business Atelier Europa', mark: 'W' },
  { id: 'Footprint', name: 'Footprint Global', detail: 'Compañía gestionada', mark: 'F' },
  { id: 'EWORKS', name: 'eWorks', detail: 'Compañía gestionada', mark: 'e' },
]);

export const AREAS = Object.freeze([
  { id: 'finance', name: 'Finanzas', short: 'Finanzas', symbol: '01', stage: 'available', description: 'Contabilidad, conciliaciones, gastos y facturas. Accede a las herramientas actuales o consulta a WOBi.', modules: [{ id: 'holded', name: 'Contabilidad en Holded' }, { id: 'cashflow', name: 'Tesorería y cashflow' }, { id: 'fiscal', name: 'Fiscalidad' }] },
  { id: 'operations', name: 'Operaciones', short: 'Operaciones', symbol: '02', stage: 'available', description: 'Documentación, correo y coordinación operativa de las compañías.', modules: [{ id: 'drive', name: 'Documentos en Drive' }, { id: 'correo', name: 'Correo' }, { id: 'conocimiento', name: 'Conocimiento' }, { id: 'calendario', name: 'Calendario' }] },
  { id: 'insurance', name: 'Seguros', short: 'Seguros', symbol: '03', stage: 'available', description: 'Consulta pólizas, vencimientos y el estado del módulo de seguros.', modules: [{ id: 'seguros', name: 'Control de seguros', sections: [
    // Destinos precisos registrados en el catálogo (contrato en docs/navegador-wobi-contrato.md). `implemented: false` hasta que el front
    // tenga la vista exacta y sepa abrirla: mientras tanto el servidor responde «destino no implementado», nunca abre el módulo genérico.
    { id: 'pagos_pendientes', name: 'Pagos pendientes de seguros', description: 'Pagos de pólizas todavía sin confirmar, de la compañía elegida.', scope: 'company', implemented: false },
    { id: 'proximas_renovaciones', name: 'Próximas renovaciones de seguros', description: 'Renovaciones y vencimientos próximos de las pólizas de la compañía elegida.', scope: 'company', implemented: false },
    { id: 'actividad', name: 'Actividad de Wobi Seguros', description: 'Lo que ha hecho Wobi Seguros y cuándo. Es la actividad del grupo completo, no de una sola compañía.', scope: 'group', implemented: false },
  ] }] },
  { id: 'corporate', name: 'Corporate', short: 'Corporate', symbol: '04', stage: 'documents', description: 'Documentación corporativa y espacio de planeación estratégica por compañía. La fuente de los planes se conectará cuando estén aprobados.', modules: [{ id: 'drive', name: 'Documentación corporativa' }, { id: 'strategic_planning', name: 'Planeación estratégica' }] },
  { id: 'people', name: 'Gestión humana', short: 'Personas', symbol: '05', stage: 'planned', description: 'Espacio previsto para personas y procesos de gestión humana. Todavía sin agente especializado.', modules: [] },
  { id: 'marketing', name: 'Marketing y social media', short: 'Marketing', symbol: '06', stage: 'planned', description: 'Campañas y seguimiento de redes de cada compañía. Las cuentas sociales todavía no están integradas.', modules: [] },
  { id: 'commercial', name: 'Ventas y clientes', short: 'Comercial', symbol: '07', stage: 'planned', description: 'Espacio para ventas y clientes. El programa externo de generación de leads de eWorks está pendiente de integración.', modules: [] },
  { id: 'procurement', name: 'Compras y proveedores', short: 'Compras', symbol: '08', stage: 'planned', description: 'Espacio reservado para compras, proveedores y sus flujos de aprobación.', modules: [] },
  { id: 'compliance', name: 'Compliance', short: 'Compliance', symbol: '09', stage: 'planned', description: 'Espacio previsto para cumplimiento normativo en España y su futuro agente especializado.', modules: [] },
  { id: 'quality', name: 'Calidad y medioambiente', short: 'ISO', symbol: '10', stage: 'planned', description: 'Espacio previsto para gestionar ISO 9001 y 14001, inicialmente en WOBA. El agente ISO todavía no está integrado.', modules: [] },
  { id: 'technology', name: 'Tecnología y seguridad', short: 'Tecnología', symbol: '11', stage: 'planned', description: 'Espacio reservado para tecnología y seguridad de la información. El futuro agente de seguridad se integrará aquí.', modules: [] },
  { id: 'processes', name: 'Procesos', short: 'Procesos', symbol: '12', stage: 'planned', description: 'Espacio para los procesos documentados de cada compañía en Drive: procedimientos, responsables y seguimiento. Aquí se integrará el futuro subagente de Procesos; todavía no está desarrollado ni conectado.', modules: [] },
]);

export const STAGES = { available: 'Herramientas disponibles', documents: 'Consulta documental', planned: 'Previsto' };
export const companyById = id => COMPANIES.find(company => company.id === id) || COMPANIES[0];
export const areaById = id => AREAS.find(area => area.id === id) || null;
