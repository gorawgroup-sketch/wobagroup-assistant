/** Ejecuta lecturas independientes con un límite fijo y conserva el orden de entrada. */
export async function mapearConConcurrencia<T, R>(
  items: readonly T[],
  limite: number,
  tarea: (item: T, indice: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limite) || limite < 1) throw new Error("Límite de concurrencia inválido.");
  const resultados = new Array<R>(items.length);
  let siguiente = 0;
  async function trabajador(): Promise<void> {
    while (true) {
      const indice = siguiente++;
      if (indice >= items.length) return;
      resultados[indice] = await tarea(items[indice], indice);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, () => trabajador()));
  return resultados;
}
