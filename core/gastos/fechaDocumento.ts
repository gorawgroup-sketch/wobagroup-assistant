/** Una fecha ausente o imposible no autoriza usar hoy como fecha del gasto. */
export function esFechaDocumentoValida(fecha: string | undefined): boolean {
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const instante = new Date(`${fecha}T12:00:00Z`);
  return Number.isFinite(instante.getTime()) && instante.toISOString().slice(0, 10) === fecha;
}
