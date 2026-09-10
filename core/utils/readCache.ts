export type OrigenLectura = "fresco" | "cache" | "compartido";

export interface MetaLectura {
  origen: OrigenLectura;
  obtenidoEn: number;
  antiguedadMs: number;
  ttlMs: number;
}

export interface LecturaConMeta<T> {
  datos: T;
  meta: MetaLectura;
}

interface Entrada<T> { datos: T; obtenidoEn: number; }
interface Vuelo<T> { generacion: number; promesa: Promise<Entrada<T>>; }
interface Metricas { cargas: number; cache: number; compartidas: number; invalidaciones: number; errores: number; }

const metricas = new Map<string, Metricas>();

function metricasDe(nombre: string): Metricas {
  let actuales = metricas.get(nombre);
  if (!actuales) {
    actuales = { cargas: 0, cache: 0, compartidas: 0, invalidaciones: 0, errores: 0 };
    metricas.set(nombre, actuales);
  }
  return actuales;
}

export function obtenerMetricasCachesLectura(): Record<string, Metricas & { llamadasEvitadas: number }> {
  return Object.fromEntries([...metricas].map(([nombre, m]) => [nombre, { ...m, llamadasEvitadas: m.cache + m.compartidas }]));
}

export function resumirMetricasCachesLectura() {
  const valores = Object.values(obtenerMetricasCachesLectura());
  return valores.reduce((total, m) => ({
    cargas: total.cargas + m.cargas,
    cache: total.cache + m.cache,
    compartidas: total.compartidas + m.compartidas,
    llamadasEvitadas: total.llamadasEvitadas + m.llamadasEvitadas,
    invalidaciones: total.invalidaciones + m.invalidaciones,
    errores: total.errores + m.errores,
  }), { cargas: 0, cache: 0, compartidas: 0, llamadasEvitadas: 0, invalidaciones: 0, errores: 0 });
}

export function limpiarMetricasCachesLecturaParaTests(): void { metricas.clear(); }

/**
 * Caché en memoria con single-flight. Una invalidación ocurrida durante la carga
 * descarta ese resultado y obliga a releer; nunca repuebla el caché con una
 * fotografía anterior a una escritura confirmada.
 */
export class CacheLectura<T> {
  private entrada: Entrada<T> | null = null;
  private vuelo: Vuelo<T> | null = null;
  private generacion = 0;

  constructor(
    private readonly nombre: string,
    private readonly ttlMs: number,
    private readonly ahora: () => number = Date.now
  ) {}

  async obtener(cargar: () => Promise<T>): Promise<LecturaConMeta<T>> {
    const instante = this.ahora();
    if (this.entrada && instante - this.entrada.obtenidoEn < this.ttlMs) {
      metricasDe(this.nombre).cache++;
      return this.resultado(this.entrada, "cache");
    }

    const existente = this.vuelo;
    if (existente) {
      metricasDe(this.nombre).compartidas++;
      return this.esperarVuelo(existente, cargar, "compartido");
    }

    const generacion = this.generacion;
    metricasDe(this.nombre).cargas++;
    const promesa = Promise.resolve()
      .then(cargar)
      .then((datos) => ({ datos, obtenidoEn: this.ahora() }))
      .catch((error) => {
        metricasDe(this.nombre).errores++;
        throw error;
      });
    const vuelo = { generacion, promesa };
    this.vuelo = vuelo;
    return this.esperarVuelo(vuelo, cargar, "fresco");
  }

  invalidar(): void {
    this.generacion++;
    this.entrada = null;
    metricasDe(this.nombre).invalidaciones++;
  }

  private async esperarVuelo(vuelo: Vuelo<T>, cargar: () => Promise<T>, origen: OrigenLectura): Promise<LecturaConMeta<T>> {
    let entrada: Entrada<T>;
    try {
      entrada = await vuelo.promesa;
    } finally {
      if (this.vuelo === vuelo) this.vuelo = null;
    }
    if (vuelo.generacion !== this.generacion) {
      // La fuente cambió mientras se leía: esta fotografía no se sirve ni se guarda.
      return this.obtener(cargar);
    }
    this.entrada = entrada;
    return this.resultado(entrada, origen);
  }

  private resultado(entrada: Entrada<T>, origen: OrigenLectura): LecturaConMeta<T> {
    return {
      datos: entrada.datos,
      meta: {
        origen,
        obtenidoEn: entrada.obtenidoEn,
        antiguedadMs: Math.max(0, this.ahora() - entrada.obtenidoEn),
        ttlMs: this.ttlMs,
      },
    };
  }
}

/** Nota corta para que el modelo nunca presente un valor cacheado como recién consultado. */
export function notaFrescura(meta: MetaLectura): string {
  const segundos = Math.ceil(meta.antiguedadMs / 1000);
  if (meta.origen === "cache") return `[Frescura: caché de hace ${segundos}s; máximo ${Math.ceil(meta.ttlMs / 1000)}s]`;
  if (meta.origen === "compartido") return `[Frescura: lectura compartida completada hace ${segundos}s]`;
  return "[Frescura: consulta nueva]";
}
