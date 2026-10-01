/**
 * Lectura COMPLETA de los movimientos de una cuenta bancaria de Holded en un rango de fechas.
 *
 * Caso real (Carlos, 2026-10-01, citizenM 124,91 €, Footprint): la propuesta decía «no encontré ningún movimiento
 * bancario sin conciliar» y el cargo «Hotel At Booking.com −124,91 €» del 29/08 estaba en el banco, libre. Holded
 * devuelve los movimientos por páginas, del más reciente al más antiguo. Las búsquedas leían SOLO la primera página y
 * daban el resultado por completo: en la cuenta Main, una ventana de tres meses no pasaba del 8 de septiembre. Todo
 * cargo más antiguo que la primera página era invisible para la conciliación.
 *
 * Contrato: o se devuelven TODOS los movimientos del rango, o se lanza ConsultaBancariaIncompletaError. Nunca una
 * lista parcial presentada como completa: un «no hay cargo» solo vale si se leyó todo.
 */
export class ConsultaBancariaIncompletaError extends Error {
  constructor(motivo: string) {
    super(`Consulta bancaria incompleta (${motivo}); no se puede afirmar que no exista un cargo.`);
    this.name = "ConsultaBancariaIncompletaError";
  }
}

export interface PaginaMovimientos<T> { items?: T[]; has_more?: boolean; cursor?: string | null }

/** 300 páginas de 200 movimientos = 60.000 por cuenta y consulta: muy por encima de cualquier ventana real. */
export const MAX_PAGINAS_MOVIMIENTOS = 300;

export async function paginarMovimientosBancarios<T>(
  leerPagina: (parametros: Record<string, string>) => Promise<PaginaMovimientos<T> | T[] | unknown>,
  filtros: { start_date?: string; end_date?: string },
  maxPaginas = MAX_PAGINAS_MOVIMIENTOS
): Promise<T[]> {
  const base: Record<string, string> = { limit: "200" };
  if (filtros.start_date) base.start_date = filtros.start_date;
  if (filtros.end_date) base.end_date = filtros.end_date;
  const todos: T[] = [];
  const cursores = new Set<string>();
  let cursor: string | undefined;
  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const respuesta = await leerPagina(cursor ? { ...base, cursor } : base);
    // Algunas rutas antiguas devuelven la lista directamente, sin paginar.
    if (Array.isArray(respuesta)) return [...todos, ...(respuesta as T[])];
    const data = (respuesta ?? {}) as PaginaMovimientos<T>;
    todos.push(...(data.items ?? []));
    if (!data.has_more) return todos;
    if (typeof data.cursor !== "string" || !data.cursor) throw new ConsultaBancariaIncompletaError("Holded indicó más páginas sin dar el cursor");
    if (cursores.has(data.cursor)) throw new ConsultaBancariaIncompletaError("Holded repitió el cursor de paginación");
    cursores.add(data.cursor);
    cursor = data.cursor;
  }
  throw new ConsultaBancariaIncompletaError(`más de ${maxPaginas} páginas de movimientos`);
}
