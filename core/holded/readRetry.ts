const ESTADOS_TRANSITORIOS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface OpcionesReintentoLecturaHolded {
  intentosMaximos?: number;
  demoraBaseMs?: number;
  esperar?: (ms: number) => Promise<void>;
  aleatorio?: () => number;
  alReintentar?: (datos: { intento: number; demoraMs: number; status?: number }) => void;
}

export function estadoHttpErrorHolded(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isInteger(status)) return status;
  }
  const mensaje = error instanceof Error ? error.message : String(error);
  const match = mensaje.match(/API de Holded \((\d{3})\)/i);
  return match ? Number(match[1]) : undefined;
}

/**
 * Solo reintenta fallos que pueden desaparecer sin cambiar ninguna decisión:
 * errores 5xx/rate-limit/timeouts de una lectura GET. Nunca debe envolver un
 * POST, PUT, conciliación o cualquier otra escritura contable.
 */
export function esFalloTransitorioLecturaHolded(error: unknown): boolean {
  const status = estadoHttpErrorHolded(error);
  if (status !== undefined) return ESTADOS_TRANSITORIOS.has(status);
  if (!(error instanceof Error)) return false;
  return error instanceof TypeError || error.name === "AbortError" || error.name === "TimeoutError";
}

export async function conReintentoLecturaHolded<T>(
  leer: () => Promise<T>,
  opciones: OpcionesReintentoLecturaHolded = {}
): Promise<T> {
  const intentosMaximos = Math.max(1, Math.min(4, opciones.intentosMaximos ?? 3));
  const demoraBaseMs = Math.max(0, Math.min(5_000, opciones.demoraBaseMs ?? 250));
  const esperar = opciones.esperar ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const aleatorio = opciones.aleatorio ?? Math.random;

  for (let intento = 1; ; intento++) {
    try {
      return await leer();
    } catch (error) {
      if (intento >= intentosMaximos || !esFalloTransitorioLecturaHolded(error)) throw error;
      const exponencial = demoraBaseMs * 2 ** (intento - 1);
      const jitter = Math.floor(demoraBaseMs * 0.2 * Math.max(0, Math.min(1, aleatorio())));
      const demoraMs = exponencial + jitter;
      opciones.alReintentar?.({ intento, demoraMs, status: estadoHttpErrorHolded(error) });
      await esperar(demoraMs);
    }
  }
}
