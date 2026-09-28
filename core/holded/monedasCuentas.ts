export interface CuentaConMoneda {
  currency?: string;
  archived?: boolean;
}

/** Monedas de las cuentas de tesorería activas (no archivadas, con moneda). */
export function monedasDeCuentasActivas(cuentas: CuentaConMoneda[]): Set<string> {
  return new Set(
    cuentas
      .filter((c) => !c.archived && c.currency)
      .map((c) => (c.currency as string).toUpperCase().trim())
      .filter(Boolean)
  );
}

/**
 * Monedas de las cuentas REALES de cada empresa, con memoria de la última lectura buena.
 *
 * Caso real (Footprint, 2026-09-28 13:26 UTC): Holded devolvió 502/503 a GET /treasury/accounts, se agotaron los
 * reintentos y el flujo asumió «solo EUR», con lo que respondió que USD «no es ninguna de las monedas de cuenta real»
 * de una empresa que tiene cuentas en USD y COP. Un fallo de lectura no demuestra ninguna moneda: aquí NUNCA se
 * inventa un valor. Si la lectura falla se devuelve la última lectura buena de esa empresa (las cuentas cambian muy
 * rara vez) y, si no hay ninguna, se relanza el error para que el flujo avise y se pueda reintentar.
 */
export class MonedasCuentasReales {
  private readonly ultimaBuena = new Map<string, { monedas: Set<string>; leidaEn: number }>();

  constructor(
    private readonly cargar: (empresa: string) => Promise<CuentaConMoneda[]>,
    private readonly ahora: () => number = Date.now,
    private readonly avisar: (mensaje: string, error: unknown) => void = (mensaje, error) => console.warn(mensaje, error)
  ) {}

  async obtener(empresa: string): Promise<Set<string>> {
    try {
      const monedas = monedasDeCuentasActivas(await this.cargar(empresa));
      // Una lista vacía tampoco demuestra que no haya cuentas: se trata como lectura fallida.
      if (monedas.size === 0) throw new Error(`Holded no devolvió ninguna cuenta de tesorería activa con moneda para ${empresa}.`);
      this.ultimaBuena.set(empresa, { monedas, leidaEn: this.ahora() });
      return new Set(monedas);
    } catch (error) {
      const previa = this.ultimaBuena.get(empresa);
      if (!previa) throw error;
      const minutos = Math.round((this.ahora() - previa.leidaEn) / 60_000);
      this.avisar(
        `[monedasCuentas] No se pudieron leer las cuentas de ${empresa} en Holded; se usa la última lectura buena (hace ${minutos} min): ` +
          `${[...previa.monedas].sort().join(", ")}.`,
        error instanceof Error ? error.message : error
      );
      return new Set(previa.monedas);
    }
  }
}
