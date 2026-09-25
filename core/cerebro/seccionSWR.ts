/**
 * Caché "servir lo último y refrescar detrás" (stale-while-revalidate) para las secciones del panel /cerebro.
 *
 * Por qué existe (medido en producción el 2026-09-25): el panel tardaba 38 s (hasta 115 s) en cargar porque
 * cada lectura caducada o invalidada obligaba a esperar el recálculo completo, y cada aviso en tiempo real
 * descartaba la lectura en curso y empezaba otra. Aquí:
 *  - quien lee recibe SIEMPRE lo último que hay, al instante; solo espera si nunca hubo lectura (primer
 *    arranque) o si lo que hay es demasiado antiguo (`maxVencidaMs`);
 *  - una lectura caducada o invalidada se recalcula en segundo plano, una sola vez a la vez (single-flight);
 *  - las invalidaciones se COALESCEN: una ráfaga produce como mucho una lectura más, nunca un bucle; una
 *    lectura ya completada jamás se descarta (se sirve y, si hubo invalidación después de empezar, se
 *    repite una vez con la fuente ya invalidada);
 *  - si la lectura falla se conserva la anterior y se reintenta con espera, sin tumbar a nadie.
 * La honestidad sobre la antigüedad se conserva: cada lectura devuelve `obtenidoEn` (cuándo se calculó de
 * verdad) y `refrescando`.
 */

export interface LecturaSeccion<T> {
  datos: T;
  /** Instante (ms) en que se calcularon realmente estos datos. */
  obtenidoEn: number;
  /** true si hay un recálculo en curso o pendiente (lo que se devuelve puede estar desactualizado). */
  refrescando: boolean;
  /** true si estos datos ya superaron su TTL o fueron invalidados. */
  vencida: boolean;
}

export interface OpcionesSeccionSWR<T> {
  nombre: string;
  /** Tiempo durante el que los datos se consideran frescos. */
  ttlMs: number;
  cargar: () => Promise<T>;
  /** Por encima de esta antigüedad quien lee espera el recálculo en vez de recibir datos viejos. */
  maxVencidaMs?: number;
  /** Espera mínima antes de recalcular tras una invalidación: agrupa ráfagas de avisos. */
  esperaCoalescerMs?: number;
  /** Espera mínima entre intentos tras un fallo. */
  esperaTrasFalloMs?: number;
  /** Una lectura que no termina en este tiempo se da por fallida (no deja el vuelo colgado ni bloquea «actualizar»). */
  timeoutCargaMs?: number;
  /** Se ejecuta en el mismo instante de invalidar (p. ej. para vaciar cachés de fuentes más bajas). */
  alInvalidar?: () => void;
  /** Se llama cuando termina un recálculo provocado por una invalidación (no por caducidad normal). */
  alCompletarInvalidada?: (nombre: string) => void;
  ahora?: () => number;
}

// Sin `unref`: alguien está esperando este temporizador; si fuera el único pendiente, el proceso terminaría con la promesa sin resolver.
const dormir = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

export class SeccionSWR<T> {
  readonly nombre: string;
  private entrada: { datos: T; obtenidoEn: number } | null = null;
  private vuelo: Promise<void> | null = null;
  private version = 0; // sube en cada invalidación
  private versionCargada = 0; // versión vigente cuando empezó la última lectura completada
  private provocadaPorInvalidacion = false;
  /** Una orden explícita del usuario: la lectura repite sin la espera de coalescencia. */
  private urgente = false;
  private ultimoFalloEn = 0;
  private readonly ahora: () => number;

  constructor(private readonly opciones: OpcionesSeccionSWR<T>) {
    this.nombre = opciones.nombre;
    this.ahora = opciones.ahora ?? Date.now;
  }

  private get ttl() { return this.opciones.ttlMs; }
  private get maxVencida() { return this.opciones.maxVencidaMs ?? 30 * 60_000; }
  private get sucia() { return this.entrada !== null && this.version !== this.versionCargada; }

  private edad(): number { return this.entrada ? this.ahora() - this.entrada.obtenidoEn : Number.POSITIVE_INFINITY; }
  private vencida(): boolean { return this.entrada === null || this.sucia || this.edad() >= this.ttl; }

  /** true si hay un recálculo en vuelo o hace falta uno (la lectura devuelta no es la más reciente posible). */
  get refrescando(): boolean { return this.vuelo !== null || (this.entrada !== null && this.vencida()); }
  /** Antigüedad de la lectura actual en ms (Infinity si no hay ninguna). */
  get antiguedadMs(): number { return this.edad(); }
  get obtenidoEn(): number | null { return this.entrada?.obtenidoEn ?? null; }
  get tieneDatos(): boolean { return this.entrada !== null; }
  get estaVencida(): boolean { return this.vencida(); }

  /**
   * Devuelve lo último que hay, al instante. Espera únicamente si no hay ninguna lectura o si lo que hay
   * supera `maxVencidaMs`. Si está vencida o invalidada, lanza el recálculo en segundo plano.
   */
  async leer(): Promise<LecturaSeccion<T>> {
    if (this.entrada === null || this.edad() >= this.maxVencida) {
      await this.refrescar();
      if (this.entrada === null) throw new Error(`No hay lectura disponible de ${this.nombre}.`);
    } else if (this.vencida()) {
      this.iniciar(false);
    }
    const entrada = this.entrada as { datos: T; obtenidoEn: number };
    return { datos: entrada.datos, obtenidoEn: entrada.obtenidoEn, refrescando: this.refrescando, vencida: this.vencida() };
  }

  /**
   * Marca los datos como desactualizados. Con `recalcularYa` (por defecto) agenda UN recálculo coalescido; sin él
   * es perezoso: solo marca, y el siguiente `leer()` (o el mantenimiento) recalcula. Sin nadie mirando el panel
   * no hay motivo para gastar cuota de Sheets/Drive/Gmail/Holded en releer.
   */
  invalidar(recalcularYa = true): void {
    this.version++;
    try { this.opciones.alInvalidar?.(); } catch (error) { console.error(`[cerebro/${this.nombre}] Error en alInvalidar:`, error); }
    this.provocadaPorInvalidacion = true;
    if (recalcularYa && this.entrada !== null) this.iniciar(true);
  }

  /**
   * Orden explícita («actualizar» del usuario): descarta lo anterior y espera una lectura que EMPIECE después de
   * esta llamada — jamás se responde con una lectura que ya estaba en curso antes de la orden. Sin esperas de
   * coalescencia. Si la lectura falla y ya había datos, se conservan y no se reintenta en bucle.
   */
  async recalcular(): Promise<void> {
    this.version++;
    try { this.opciones.alInvalidar?.(); } catch (error) { console.error(`[cerebro/${this.nombre}] Error en alInvalidar:`, error); }
    this.provocadaPorInvalidacion = true;
    this.urgente = true;
    const objetivo = this.version;
    for (let intento = 0; intento < 3 && this.versionCargada < objetivo; intento++) {
      const falloAntes = this.ultimoFalloEn;
      try { await this.iniciar(false, true); } catch (error) {
        if (this.entrada === null) throw error;
      }
      if (this.ultimoFalloEn !== 0 && this.ultimoFalloEn !== falloAntes) break;
    }
  }

  /** Recalcula y espera el resultado (compartido si ya hay uno en curso). Nunca lanza si ya hay una lectura previa. */
  async refrescar(): Promise<void> {
    const vuelo = this.iniciar(false, true);
    try { await vuelo; } catch (error) {
      if (this.entrada === null) throw error;
    }
  }

  /** Arranca el recálculo si no hay otro en curso. Devuelve la promesa del vuelo en curso. */
  private iniciar(esperarCoalescer: boolean, ignorarEsperaFallo = false): Promise<void> {
    if (this.vuelo) return this.vuelo;
    if (!ignorarEsperaFallo && this.ultimoFalloEn && this.entrada !== null &&
      this.ahora() - this.ultimoFalloEn < (this.opciones.esperaTrasFalloMs ?? 5_000)) {
      return Promise.resolve();
    }
    const vuelo = this.ciclo(esperarCoalescer).finally(() => { if (this.vuelo === vuelo) this.vuelo = null; });
    this.vuelo = vuelo;
    // El vuelo en segundo plano nunca debe convertirse en un rechazo sin manejar.
    vuelo.catch(() => undefined);
    return vuelo;
  }

  private async ciclo(esperarCoalescer: boolean): Promise<void> {
    if (esperarCoalescer) await this.esperarCoalescencia();
    // Repite mientras lleguen invalidaciones durante la lectura; cada lectura completada se conserva.
    for (let vuelta = 0; vuelta < 5; vuelta++) {
      const versionAlEmpezar = this.version;
      const porInvalidacion = this.provocadaPorInvalidacion;
      this.provocadaPorInvalidacion = false;
      try {
        const datos = await this.cargarConTimeout();
        this.entrada = { datos, obtenidoEn: this.ahora() };
        this.versionCargada = versionAlEmpezar;
        this.ultimoFalloEn = 0;
        if (porInvalidacion) {
          try { this.opciones.alCompletarInvalidada?.(this.nombre); } catch (error) { console.error(`[cerebro/${this.nombre}] Error notificando:`, error); }
        }
      } catch (error) {
        this.ultimoFalloEn = this.ahora();
        console.warn(`[cerebro/${this.nombre}] No se pudo actualizar; se conserva la última lectura:`, error instanceof Error ? error.message : error);
        this.urgente = false;
        if (this.entrada === null) throw error;
        return;
      }
      if (this.version === versionAlEmpezar) { this.urgente = false; return; }
      // Hubo una invalidación mientras se leía: una sola lectura más, tras una espera corta (salvo orden explícita).
      await this.esperarCoalescencia();
    }
    this.urgente = false;
  }

  private cargarConTimeout(): Promise<T> {
    const limite = this.opciones.timeoutCargaMs ?? 90_000;
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const tiempo = new Promise<never>((_, rechazar) => {
      temporizador = setTimeout(() => rechazar(new Error(`Tiempo de lectura agotado (${limite} ms)`)), limite);
    });
    return Promise.race([Promise.resolve().then(this.opciones.cargar), tiempo]).finally(() => { if (temporizador) clearTimeout(temporizador); });
  }

  /** Espera corta que agrupa ráfagas de invalidaciones; una orden explícita del usuario la interrumpe. */
  private async esperarCoalescencia(): Promise<void> {
    const limite = this.ahora() + (this.opciones.esperaCoalescerMs ?? 1_000);
    while (!this.urgente && this.ahora() < limite) await dormir(Math.min(50, Math.max(1, limite - this.ahora())));
  }
}
