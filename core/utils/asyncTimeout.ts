export class TiempoMaximoExcedidoError extends Error {
  constructor(public readonly operacion: string, public readonly tiempoMaximoMs: number) {
    super(`Tiempo máximo excedido en ${operacion} (${tiempoMaximoMs} ms).`);
    this.name = "TiempoMaximoExcedidoError";
  }
}

export function enteroAcotado(raw: string | undefined, defecto: number, minimo: number, maximo: number): number {
  if (!raw?.trim()) return defecto;
  const valor = Number(raw);
  return Number.isFinite(valor) ? Math.min(maximo, Math.max(minimo, Math.trunc(valor))) : defecto;
}

/** Solo para lecturas auditadas: deja de esperar, NO cancela la operación subyacente. */
export async function conTiempoMaximo<T>(operacion: () => Promise<T>, ms: number, nombre: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operacion),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TiempoMaximoExcedidoError(nombre, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
