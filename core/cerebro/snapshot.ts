import { CacheLectura, type LecturaConMeta } from "../utils/readCache";

export function crearSnapshot<T>(cargar: () => Promise<T>, invalidarFuentes: () => void, ttlMs = 30_000) {
  const cache = new CacheLectura<T>("cerebro_estado", ttlMs);
  let forzado: Promise<LecturaConMeta<T>> | undefined;
  const invalidar = () => { cache.invalidar(); invalidarFuentes(); };
  return {
    invalidar,
    obtener(forzar = false): Promise<LecturaConMeta<T>> {
      if (!forzar) return cache.obtener(cargar);
      // Varios usuarios que pulsan a la vez comparten la misma consulta nueva.
      if (!forzado) {
        invalidar();
        forzado = cache.obtener(cargar).finally(() => { forzado = undefined; });
      }
      return forzado;
    },
  };
}
