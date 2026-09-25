import { SeccionSWR } from "./seccionSWR";
import type { ConteosHolded } from "./conteosHolded";
import type { EstadoFuente } from "./lecturaFuentes";

/**
 * Orquesta las secciones del panel /cerebro: cada una con su caché "servir lo último y refrescar detrás"
 * (ver seccionSWR.ts), los conteos pesados de Holded aparte, y el mantenimiento en segundo plano que hace que
 * quien abre o recarga el panel encuentre siempre datos recientes al instante.
 *
 * Medido en producción el 2026-09-25: una lectura completa tardaba 38 s (hasta 115 s), cada recarga la
 * forzaba, y cada aviso en tiempo real hacía que todas las pestañas abiertas forzaran otra.
 */

export interface ResultadoSeccion<T> {
  datos: T;
  fuentes: EstadoFuente[];
}

export interface DefinicionSeccion<T = unknown> {
  nombre: string;
  ttlMs: number;
  cargar: () => Promise<ResultadoSeccion<T>>;
  /** Valor si la sección nunca pudo leerse (primer arranque con la fuente caída). */
  fallback: ResultadoSeccion<T>;
  alInvalidar?: () => void;
}

export interface FuenteConteos {
  leer(): ConteosHolded;
  edadMs(): number;
  refrescar(minEdadMs?: number): Promise<void>;
  necesitaRefresco(): boolean;
}

export interface OpcionesOrquestador {
  secciones: DefinicionSeccion[];
  conteos: FuenteConteos;
  /** Publica un aviso en tiempo real a los navegadores conectados. */
  publicar: (tipo: string) => void;
  /** true si hay quien mire el panel (navegadores conectados por SSE). */
  hayNavegadoresConectados: () => boolean;
  ahora?: () => number;
  /** Tiempo tras la última consulta durante el que se sigue manteniendo fresco el panel. */
  ventanaInteresMs?: number;
  /** Una orden «actualizar» dentro de este intervalo tras la anterior se atiende con lo ya calculado. */
  intervaloMinForzadoMs?: number;
  esperaCoalescerMs?: number;
  timeoutCargaMs?: number;
  intervaloMantenimientoMs?: number;
  /** Sin nadie mirando, las secciones se refrescan igualmente cada tanto, para que el primer visitante encuentre datos recientes. */
  edadMaximaOciosaMs?: number;
  /** Espera antes de publicar «estado_actualizado» (se reinicia con cada recálculo terminado). */
  esperaAvisoMs?: number;
}

export interface EstadoSecciones {
  datos: Record<string, unknown>;
  fuentes: EstadoFuente[];
  /** Instante (ms) del dato más antiguo entre todas las secciones: la frescura real del panel. */
  obtenidoEn: number;
  /** Instante (ms) del recálculo más reciente de cualquier sección: cambia cada vez que llega algo nuevo. */
  actualizadoEn: number;
  /** true si alguna sección se está recalculando o le falta un recálculo. */
  refrescando: boolean;
  conteos: ConteosHolded;
}

export function crearOrquestadorEstado(opciones: OpcionesOrquestador) {
  const ahora = opciones.ahora ?? Date.now;
  const ventanaInteres = opciones.ventanaInteresMs ?? 10 * 60_000;
  const intervaloMinForzado = opciones.intervaloMinForzadoMs ?? 2_000;
  const edadMaximaOciosa = opciones.edadMaximaOciosaMs ?? 20 * 60_000;
  let ultimaConsultaEn = 0;
  let ultimoForzadoEn = 0;
  let forzadoEnCurso: Promise<void> | null = null;
  let avisoPendiente: ReturnType<typeof setTimeout> | null = null;

  /** Un solo aviso «estado_actualizado» por ráfaga de recálculos provocados por invalidaciones. */
  const avisarEstadoActualizado = () => {
    // Cada sección que termina reinicia la espera: una ráfaga (varias secciones, varias vueltas) da UN solo aviso.
    if (avisoPendiente) clearTimeout(avisoPendiente);
    avisoPendiente = setTimeout(() => {
      avisoPendiente = null;
      opciones.publicar("estado_actualizado");
    }, opciones.esperaAvisoMs ?? 1_500);
    avisoPendiente.unref?.();
  };

  /** Hay quien mire el panel: navegadores conectados por SSE o una consulta reciente. */
  const hayInteres = () => opciones.hayNavegadoresConectados() || (ultimaConsultaEn > 0 && ahora() - ultimaConsultaEn < ventanaInteres);

  const secciones = new Map<string, SeccionSWR<ResultadoSeccion<unknown>>>();
  for (const definicion of opciones.secciones) {
    secciones.set(definicion.nombre, new SeccionSWR<ResultadoSeccion<unknown>>({
      nombre: definicion.nombre,
      ttlMs: definicion.ttlMs,
      cargar: definicion.cargar,
      alInvalidar: definicion.alInvalidar,
      alCompletarInvalidada: avisarEstadoActualizado,
      esperaCoalescerMs: opciones.esperaCoalescerMs,
      timeoutCargaMs: opciones.timeoutCargaMs,
      ahora,
    }));
  }
  const fallbacks = new Map(opciones.secciones.map((d) => [d.nombre, d.fallback]));

  async function leerTodas(): Promise<EstadoSecciones> {
    const lecturas = await Promise.all([...secciones].map(async ([nombre, seccion]) => {
      try {
        const lectura = await seccion.leer();
        return { nombre, resultado: lectura.datos, obtenidoEn: lectura.obtenidoEn, refrescando: lectura.refrescando };
      } catch {
        return { nombre, resultado: fallbacks.get(nombre) as ResultadoSeccion<unknown>, obtenidoEn: 0, refrescando: true };
      }
    }));
    const datos: Record<string, unknown> = {};
    const fuentes: EstadoFuente[] = [];
    for (const l of lecturas) {
      datos[l.nombre] = l.resultado.datos;
      fuentes.push(...l.resultado.fuentes);
    }
    // Los conteos pesados nunca bloquean a nadie: si están caducados (o nunca se calcularon) se recalculan detrás.
    if (opciones.conteos.necesitaRefresco()) void opciones.conteos.refrescar();
    const conteos = opciones.conteos.leer();
    return {
      datos,
      fuentes,
      // Una sección que nunca se pudo leer cuenta como «sin verificar» (fecha 0): jamás se disfraza de reciente.
      obtenidoEn: Math.min(...lecturas.map((l) => l.obtenidoEn)),
      actualizadoEn: Math.max(...lecturas.map((l) => l.obtenidoEn)),
      refrescando: lecturas.some((l) => l.refrescando) || conteos.refrescando,
      conteos,
    };
  }

  return {
    /**
     * Lo último que hay, al instante. Con `forzar` (solo el botón «actualizar» del usuario) recalcula todas las
     * secciones ligeras y espera ~3 s; los conteos pesados se refrescan en segundo plano sin bloquear.
     * Varias órdenes seguidas comparten la misma lectura, y una orden inmediatamente posterior a otra se atiende
     * con lo ya calculado (protege de pestañas antiguas que fuerzan en cada aviso).
     */
    async obtener(forzar = false): Promise<EstadoSecciones> {
      ultimaConsultaEn = ahora();
      if (forzar) {
        const enCurso = forzadoEnCurso;
        if (!enCurso && ahora() - ultimoForzadoEn >= intervaloMinForzado) {
          forzadoEnCurso = Promise.allSettled([...secciones.values()].map((s) => s.recalcular()))
            .then(() => { ultimoForzadoEn = ahora(); })
            .finally(() => { forzadoEnCurso = null; });
          void opciones.conteos.refrescar(2 * 60_000);
          await forzadoEnCurso;
        } else {
          // Una orden que llega con otra en curso (que empezó ANTES de este clic) o justo después de una: nunca se
          // ignora en silencio. Se espera a la que está en curso y se agenda otro recálculo; la respuesta sale marcada
          // `refrescando` y el aviso «estado_actualizado» (o el reintento del front) trae el dato nuevo.
          if (enCurso) await enCurso;
          for (const seccion of secciones.values()) seccion.invalidar(true);
        }
      }
      return leerTodas();
    },

    /**
     * Marca secciones como desactualizadas (todas si no se indican) y agenda su recálculo en segundo plano,
     * coalescido. No bloquea; cuando termina publica un único «estado_actualizado». Los conteos pesados NO se
     * tocan: tienen su propio ritmo.
     */
    invalidar(nombres?: string[]): void {
      const objetivo = nombres?.length ? nombres : [...secciones.keys()];
      // Sin nadie mirando el panel la invalidación es perezosa (solo marca): el siguiente visitante o el
      // mantenimiento recalculan. Antes cada mensaje de Telegram y cada tarea programada releían 10 fuentes.
      const recalcularYa = hayInteres();
      for (const nombre of objetivo) secciones.get(nombre)?.invalidar(recalcularYa);
    },

    /** Primera lectura de todo, para que el primer visitante tras un arranque o despliegue no espere. */
    async precalentar(): Promise<void> {
      void opciones.conteos.refrescar();
      await Promise.allSettled([...secciones.values()].map((s) => s.refrescar()));
    },

    /**
     * Un tick de mantenimiento. Con alguien mirando el panel (o que lo miró hace poco) recalcula en segundo
     * plano lo vencido; sin nadie, solo lo que supera `edadMaximaOciosaMs` (20 min), para que el primer visitante
     * no espere y sin gastar cuota de Sheets/Holded de forma continua.
     */
    mantener(): void {
      const interes = hayInteres();
      for (const seccion of secciones.values()) {
        const debeRefrescar = interes ? seccion.estaVencida : seccion.antiguedadMs >= edadMaximaOciosa;
        if (debeRefrescar) void seccion.refrescar().catch(() => undefined);
      }
      // Los conteos pesados (cientos de lecturas a Holded) solo se mantienen frescos si alguien mira el panel;
      // sin nadie, el siguiente visitante los ve con su fecha y dispara el recálculo.
      if (interes && opciones.conteos.necesitaRefresco()) void opciones.conteos.refrescar();
    },

    /** Arranca el mantenimiento periódico; devuelve la función que lo detiene. */
    iniciar(): () => void {
      const id = setInterval(() => this.mantener(), opciones.intervaloMantenimientoMs ?? 15_000);
      id.unref?.();
      return () => clearInterval(id);
    },

    nombresSecciones(): string[] { return [...secciones.keys()]; },

    /** Antigüedad y estado de cada sección y de los conteos pesados: para /health (no contiene datos de negocio). */
    diagnostico() {
      const edad = (ms: number) => (Number.isFinite(ms) ? Math.round(ms / 1000) : null);
      return {
        secciones: Object.fromEntries([...secciones].map(([nombre, s]) => [nombre, { edadSegundos: edad(s.antiguedadMs), refrescando: s.refrescando }])),
        conteosPesados: { edadSegundos: edad(opciones.conteos.edadMs()), refrescando: opciones.conteos.leer().refrescando },
      };
    },
  };
}

export type OrquestadorEstado = ReturnType<typeof crearOrquestadorEstado>;
