// System-wide operational counts, not filtered company balances.
export function systemAttention(data) {
  const specs = [
    { module: 'cashflow', label: 'Propuestas de cashflow', source: 'cashflow.propuestas', value: data?.cashflow?.propuestasPendientes?.length },
    { module: 'correo', label: 'Borradores por aprobar', source: 'correo.borradores', value: data?.correo?.borradoresPendientesDeAprobacion },
    { module: 'holded', label: 'Gastos sin comprobante', source: 'holded', value: data?.holded?.gastosSinComprobante },
    { module: 'holded', label: 'Movimientos sin conciliar', source: 'holded', value: data?.holded?.movimientosSinConciliar },
  ];
  return specs.map(item => {
    const failed = data?.fuentes?.some(source => !source.ok && (source.fuente === item.module || source.fuente === item.source || source.fuente.startsWith(`${item.source}.`)));
    const valid = item.value !== null && item.value !== undefined && Number.isFinite(Number(item.value));
    return { ...item, value: failed || !valid ? null : Number(item.value) };
  });
}
