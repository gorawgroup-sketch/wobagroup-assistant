/** Ejecuta lecturas independientes con un límite fijo y conserva el orden de entrada. Al primer error deja de lanzar tareas nuevas. */
export async function mapearConConcurrencia<T, R>(
  items: readonly T[],
  limite: number,
  tarea: (item: T, indice: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limite) || limite < 1) throw new Error("Límite de concurrencia inválido.");
  const resultados = new Array<R>(items.length);
  let siguiente = 0;
  // Tras el primer error no se lanzan más tareas: Promise.all ya rechazó y seguir pidiendo solo gastaría cuota.
  let abortado = false;
  async function trabajador(): Promise<void> {
    while (!abortado) {
      const indice = siguiente++;
      if (indice >= items.length) return;
      try {
        resultados[indice] = await tarea(items[indice], indice);
      } catch (error) {
        abortado = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, () => trabajador()));
  return resultados;
}
