/** Cashflow balances are shared by WOBA and eWorks; entity views never inherit them. */
export function cashflowRows(snapshot, period, formatMoney, timeAgo) {
  const cashflow = snapshot?.cashflow || {};
  const sources = snapshot?.fuentes || [];
  const sourceFailed = name => {
    const state = sources.find(item => item.fuente === name);
    return !state || !state.ok;
  };
  const rows = [];
  const balance = period === 'mes' ? cashflow.balanceUltimoMes : cashflow.balanceUltimaSemana;

  if (sourceFailed('cashflow.semanas')) {
    rows.push(['Balance del periodo', 'Sin lectura actual']);
  } else if (balance && period === 'mes') {
    rows.push([`Balance ${balance.mesLabel}`, formatMoney(balance.balanceFinal)]);
    rows.push([`Ingresos de ${balance.mesLabel}`, formatMoney(balance.ingresos)]);
    rows.push([`Gastos de ${balance.mesLabel}`, formatMoney(balance.gastos)]);
  } else if (balance) {
    rows.push([`Balance ${balance.semana}`, formatMoney(balance.balanceFinal)]);
  } else {
    rows.push(['Balance del periodo', 'No disponible en el archivo']);
  }

  rows.push(['Propuestas pendientes', sourceFailed('cashflow.propuestas') ? 'Sin lectura actual' : String((cashflow.propuestasPendientes || []).length)]);
  rows.push(['Pagos recurrentes catalogados', String((cashflow.pagosRecurrentes || []).length)]);
  const lastRun = cashflow.ultimaDeteccionHolded;
  if (sourceFailed('cashflow.ultimoRun')) rows.push(['Última revisión de Holded', 'Sin lectura actual']);
  else if (lastRun) rows.push(['Última revisión de Holded', timeAgo(lastRun)]);

  const alerts = cashflow.alertasPagosRecurrentesProximas || [];
  if (alerts.length === 0) rows.push(['Próximas alertas de pagos recurrentes', 'ninguna en ventana']);
  else alerts.forEach(alert => rows.push([`⏰ ${alert.concepto} (${alert.empresa})`, alert.diasRestantes === 0 ? 'vence HOY' : `en ${alert.diasRestantes} día(s)`]));
  return rows;
}

export function companyCashflowRows(snapshot, companyId) {
  if (companyId === 'Footprint') return [];
  const cashflow = snapshot?.cashflow || {};
  const sources = snapshot?.fuentes || [];
  const proposals = sources.find(item => item.fuente === 'cashflow.propuestas');
  const rows = [
    ['Propuestas pendientes', !proposals || !proposals.ok ? 'Sin lectura actual' : String((cashflow.propuestasPendientes || []).length)],
    ['Pagos recurrentes catalogados', String((cashflow.pagosRecurrentes || []).length)],
  ];
  const alerts = cashflow.alertasPagosRecurrentesProximas || [];
  if (alerts.length === 0) rows.push(['Próximas alertas de pagos recurrentes', 'ninguna en ventana']);
  else alerts.forEach(alert => rows.push([`⏰ ${alert.concepto} (${alert.empresa})`, alert.diasRestantes === 0 ? 'vence HOY' : `en ${alert.diasRestantes} día(s)`]));
  return rows;
}
