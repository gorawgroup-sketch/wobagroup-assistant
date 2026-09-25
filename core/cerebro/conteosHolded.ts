import type { Empresa } from "../holded/client";

/**
 * Los dos conteos pesados del panel: «gastos sin comprobante» y «movimientos sin conciliar» (ventana de 90
 * días). Medido en producción el 2026-09-25: eran ~23 s de los ~26 s (38 s en producción) que tardaba cada
 * lectura completa del panel — Holded no ofrece un conteo directo, así que se recorren compras y
 * movimientos uno a uno. Como son solo números de resumen, no se calculan dentro de la petición del
 * usuario: se calculan aparte, en segundo plano, y el panel muestra el último valor con su fecha
 * («actualizado hace X min»). Si una lectura falla se conserva el valor anterior, nunca un cero inventado.
 */

export const EMPRESAS_CONTEO: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];

export interface MetricaConteo {
  valor: number;
  /** Instante (ms) del último cálculo correcto. */
  en: number;
}

export interface ConteoEmpresa {
  gastosSinComprobante: number | null;
  movimientosSinConciliar: number | null;
}

export interface ConteosHolded {
  porEmpresa: Record<string, ConteoEmpresa>;
  gastosSinComprobante: number | null;
  movimientosSinConciliar: number | null;
  /** Instante ISO del cálculo más antiguo entre las 6 métricas; null mientras falte alguna. */
  actualizadoEn: string | null;
  refrescando: boolean;
  /** true si alguna métrica se conserva de una lectura anterior porque la última falló. */
  conservado: boolean;
}

export interface CargadoresConteo {
  gastosSinComprobante(empresa: Empresa): Promise<number>;
  movimientosSinConciliar(empresa: Empresa): Promise<number>;
}

export class ConteosHoldedPesados {
  private metricas = new Map<string, MetricaConteo>();
  private vuelo: Promise<void> | null = null;
  private ultimoIntentoEn = 0;
  private fallosRecientes = new Set<string>();

  constructor(
    private readonly cargadores: CargadoresConteo,
    private readonly opciones: { ttlMs?: number; timeoutMs?: number; backoffMs?: number; ahora?: () => number } = {}
  ) {}

  private get ahora() { return this.opciones.ahora ?? Date.now; }
  private get ttl() { return this.opciones.ttlMs ?? 15 * 60_000; }

  private clave(empresa: string, tipo: "sinComprobante" | "sinConciliar") { return `${empresa}:${tipo}`; }

  /** Último valor conocido, al instante y sin tocar Holded. */
  leer(): ConteosHolded {
    const porEmpresa: Record<string, ConteoEmpresa> = {};
    let sumaGastos = 0, sumaMov = 0, completo = true, masAntigua = Number.POSITIVE_INFINITY;
    for (const empresa of EMPRESAS_CONTEO) {
      const g = this.metricas.get(this.clave(empresa, "sinComprobante"));
      const m = this.metricas.get(this.clave(empresa, "sinConciliar"));
      porEmpresa[empresa] = { gastosSinComprobante: g?.valor ?? null, movimientosSinConciliar: m?.valor ?? null };
      if (g && m) { sumaGastos += g.valor; sumaMov += m.valor; masAntigua = Math.min(masAntigua, g.en, m.en); } else completo = false;
    }
    return {
      porEmpresa,
      gastosSinComprobante: completo ? sumaGastos : null,
      movimientosSinConciliar: completo ? sumaMov : null,
      actualizadoEn: completo && Number.isFinite(masAntigua) ? new Date(masAntigua).toISOString() : null,
      refrescando: this.vuelo !== null,
      conservado: this.fallosRecientes.size > 0,
    };
  }

  /** Antigüedad (ms) del cálculo más antiguo; Infinity si falta alguna métrica. */
  edadMs(): number {
    let masAntigua = Number.POSITIVE_INFINITY, completo = true;
    for (const empresa of EMPRESAS_CONTEO) {
      for (const tipo of ["sinComprobante", "sinConciliar"] as const) {
        const m = this.metricas.get(this.clave(empresa, tipo));
        if (!m) { completo = false; continue; }
        masAntigua = Math.min(masAntigua, m.en);
      }
    }
    return completo && Number.isFinite(masAntigua) ? this.ahora() - masAntigua : Number.POSITIVE_INFINITY;
  }

  /**
   * Tras un intento con algún fallo no se reintenta hasta pasado el backoff (5 min): una métrica que falla de forma
   * persistente (429/5xx de Holded, API key ausente) no puede provocar cientos de lecturas cada 15 s.
   */
  private enBackoff(): boolean {
    return this.fallosRecientes.size > 0 && this.ultimoIntentoEn > 0 && this.ahora() - this.ultimoIntentoEn < (this.opciones.backoffMs ?? 5 * 60_000);
  }

  necesitaRefresco(): boolean { return !this.enBackoff() && this.edadMs() >= this.ttl; }

  /**
   * Recalcula las 6 métricas (3 empresas × 2) en paralelo. Comparte el vuelo en curso. `minEdadMs` evita
   * repetir el cálculo si ya es reciente (p. ej. el botón «actualizar» pulsado varias veces).
   */
  refrescar(minEdadMs = 0): Promise<void> {
    if (this.vuelo) return this.vuelo;
    if (minEdadMs > 0 && this.edadMs() < minEdadMs) return Promise.resolve();
    if (this.enBackoff()) return Promise.resolve();
    this.ultimoIntentoEn = this.ahora();
    const vuelo = this.calcular().finally(() => { if (this.vuelo === vuelo) this.vuelo = null; });
    this.vuelo = vuelo;
    vuelo.catch(() => undefined);
    return vuelo;
  }

  private async calcular(): Promise<void> {
    const timeoutMs = this.opciones.timeoutMs ?? 180_000;
    const leer = async (empresa: Empresa, tipo: "sinComprobante" | "sinConciliar") => {
      const clave = this.clave(empresa, tipo);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const cargar = tipo === "sinComprobante" ? this.cargadores.gastosSinComprobante(empresa) : this.cargadores.movimientosSinConciliar(empresa);
        const valor = await Promise.race([
          cargar,
          new Promise<never>((_, rechazar) => { timer = setTimeout(() => rechazar(new Error("Tiempo de lectura agotado")), timeoutMs); }),
        ]);
        if (!Number.isFinite(valor) || valor < 0) throw new Error("Conteo inválido");
        this.metricas.set(clave, { valor, en: this.ahora() });
        this.fallosRecientes.delete(clave);
      } catch (error) {
        this.fallosRecientes.add(clave);
        console.warn(`[cerebro/conteos] No se pudo actualizar ${clave}; ${this.metricas.has(clave) ? "se conserva el valor anterior" : "sin dato verificado"}:`,
          error instanceof Error ? error.message : error);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await Promise.all(EMPRESAS_CONTEO.flatMap((e) => [leer(e, "sinComprobante"), leer(e, "sinConciliar")]));
  }
}
