/** Bloques contiguos de lecturas independientes; cualquier otra operación es una barrera. */
export async function ejecutarLoteOrdenado<T, R>(
  elementos: readonly T[],
  paralelizable: (elemento: T) => boolean,
  ejecutar: (elemento: T, signal: AbortSignal) => Promise<R>,
  paralelo = true
): Promise<R[]> {
  const resultados: R[] = [];
  for (let i = 0; i < elementos.length;) {
    const inicio = i++;
    if (paralelo && paralelizable(elementos[inicio])) {
      while (i < elementos.length && paralelizable(elementos[i])) i++;
    }
    const abortar = new AbortController();
    let fallo: unknown;
    let hayFallo = false;
    const grupo = elementos.slice(inicio, i).map(async (elemento) => {
      try {
        abortar.signal.throwIfAborted();
        return await ejecutar(elemento, abortar.signal);
      } catch (error) {
        if (!hayFallo) { fallo = error; hayFallo = true; abortar.abort(error); }
        throw error;
      }
    });
    const resueltos = await Promise.allSettled(grupo);
    if (hayFallo) throw fallo; // No iniciar una escritura tras un fallo de lectura.
    for (const resultado of resueltos) {
      if (resultado.status === "fulfilled") resultados.push(resultado.value);
    }
  }
  return resultados;
}
