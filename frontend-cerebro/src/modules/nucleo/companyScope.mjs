// UI context only. Authorization always belongs to the API, never to this filter.
const COMPANY_MODULES = new Set(['holded', 'drive', 'seguros', 'fiscal', 'calendario', 'cashflow']);
const nameFor = id => ({ WOBA: 'WOBA', EWORKS: 'eWorks', Footprint: 'Footprint Global' })[id] || id;
const belongsTo = (item, id) => item?.empresa === id;
const onlyCompany = (items, id) => Array.isArray(items) ? items.filter(item => belongsTo(item, id)) : [];

export function companyScopeNote(moduleId, companyName) {
  if (moduleId === 'administracion') return 'Configuración global del sistema. Solo disponible con acceso de administración verificado por el servidor.';
  if (moduleId === 'cashflow' && companyName === 'Footprint Global') return 'Footprint no tiene un archivo Cashflow conectado. No se atribuyen a esta compañía los balances del archivo WOBA/eWorks.';
  if (moduleId === 'cashflow') return `Propuestas y pagos identificados de ${companyName}. Los balances del Sheet son conjuntos (WOBA/eWorks) y no se atribuyen a una sola compañía.`;
  if (COMPANY_MODULES.has(moduleId)) return `Datos identificados de ${companyName}. El selector no altera tus permisos.`;
  return 'Vista conjunta del sistema. Esta fuente no ofrece una separación fiable por compañía.';
}

export function scopeSnapshot(moduleId, snapshot, companyId) {
  if (!snapshot || !COMPANY_MODULES.has(moduleId)) return snapshot;
  const result = { ...snapshot };
  switch (moduleId) {
    case 'holded': {
      const source = snapshot.holded || {};
      result.holded = { ...source, porEmpresa: { [companyId]: source.porEmpresa?.[companyId] || { facturasUltimos7dias: null, gastosSinComprobante: null, movimientosSinConciliar: null } } };
      break;
    }
    case 'drive': {
      const source = snapshot.drive || {};
      result.drive = { ...source, porEmpresa: { [companyId]: source.porEmpresa?.[companyId] || { archivosUltimos7dias: null } }, ultimoArchivo: belongsTo(source.ultimoArchivo, companyId) ? source.ultimoArchivo : null };
      break;
    }
    case 'seguros': {
      const source = snapshot.seguros || {};
      const polizas = onlyCompany(source.polizas, companyId);
      result.seguros = { ...source, polizas, proximasARenovar: onlyCompany(source.proximasARenovar, companyId), pagosSinConfirmar: onlyCompany(source.pagosSinConfirmar, companyId), porEmpresa: { [companyId]: source.porEmpresa?.[companyId] || { total: 0, vigentes: 0, pendientesConfirmar: 0 } }, totalPolizasActivas: polizas.filter(item => item.estado !== 'no_contratada').length };
      break;
    }
    case 'fiscal': {
      const source = snapshot.fiscal || {};
      result.fiscal = { ...source, proximasAlertas: onlyCompany(source.proximasAlertas, companyId), catalogoPagosRecurrentes: onlyCompany(source.catalogoPagosRecurrentes, companyId) };
      break;
    }
    case 'calendario': {
      const source = snapshot.crm || {};
      result.crm = { ...source, actividadesProgramadas: onlyCompany(source.actividadesProgramadas, companyId) };
      break;
    }
    case 'cashflow': {
      const source = snapshot.cashflow || {};
      result.cashflow = { ...source, balanceUltimaSemana: null, balanceUltimoMes: null, ultimaDeteccionHolded: null, propuestasPendientes: onlyCompany(source.propuestasPendientes, companyId), pagosRecurrentes: onlyCompany(source.pagosRecurrentes, companyId), alertasPagosRecurrentesProximas: onlyCompany(source.alertasPagosRecurrentesProximas, companyId), linkSheet: null };
      break;
    }
  }
  return result;
}
