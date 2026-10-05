import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Control de cuota de Google Sheets para TODO el proceso, en un solo punto.
 *
 * Caso real (repetido; última vez 2026-09-29 08:16 y 2026-09-28 19:11/20:06): cada arranque del
 * servicio y cada ráfaga (Cerebro, resumen diario, vigilante de atascos con 13 lecturas por
 * admin) supera las 60 lecturas por minuto que Google concede a la cuenta de servicio. El 429
 * no es inofensivo: `inferirCuentaGasto` ignora la corrección de cuenta ya aprendida, el vigilante
 * no puede comprobar si un correo tiene pregunta viva y no actúa, y Cerebro se queda con datos
 * viejos. Hay 38 módulos con su propio cliente de Sheets; arreglarlos uno a uno ya se intentó por
 * partes (bloques 3 y 5) y la ráfaga reaparece en el siguiente módulo.
 *
 * Igual que el timeout global (ver globalOptions.ts), esto se instala UNA vez como `adapter`
 * de googleapis y cubre a todos los módulos presentes y futuros. Se usa `adapter` y no
 * `fetchImplementation` a propósito: el adaptador envuelve la petición conservando el transporte
 * que gaxios ya usaba (node-fetch), así que Gmail y las subidas a Drive no cambian en nada:
 *  - Ventana deslizante: nunca se envían más de N lecturas (ni N escrituras) por minuto. Lo que
 *    no cabe ESPERA en cola; no falla.
 *  - Prioridad: el trabajo de fondo (refrescos de Cerebro) cede una reserva al trabajo
 *    interactivo (chat, botones, revisión de correo), que pasa primero.
 *  - Si aun así Google responde 429 a una LECTURA (dos contenedores solapados en un despliegue
 *    comparten la cuota), se reintenta tras una pausa. Las escrituras nunca se reintentan aquí:
 *    repetir una escritura es decisión del almacén que la hace, no de la capa de transporte.
 */
export type PrioridadSheets = "interactiva" | "fondo";
type Tipo = "lectura" | "escritura";

const contextoPrioridad = new AsyncLocalStorage<PrioridadSheets>();
const contextoCancelacion = new AsyncLocalStorage<AbortSignal>();

/** Marca todo lo que se ejecute dentro como trabajo de fondo (o interactivo) frente a la cuota. */
export function conPrioridadSheets<T>(prioridad: PrioridadSheets, tarea: () => Promise<T>): Promise<T> {
  return contextoPrioridad.run(prioridad, tarea);
}

/** Cancela lecturas Sheets que todavía esperan turno cuando su consumidor ya expiró. */
export function conCancelacionSheets<T>(senal: AbortSignal, tarea: () => Promise<T>): Promise<T> {
  return contextoCancelacion.run(senal, tarea);
}

interface Dependencias {
  ahora: () => number;
  programar: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> | void;
}
const REALES: Dependencias = {
  ahora: Date.now,
  // Sin unref a propósito: el despertador solo existe mientras hay peticiones esperando turno, y una
  // petición en espera es trabajo real. Con unref, un script o tarea cuyo único trabajo pendiente eran
  // lecturas en cola terminaba en silencio sin hacerlas (detectado en la verificación en vivo).
  programar: (fn, ms) => setTimeout(fn, ms),
};

export class LimitadorVentana {
  private readonly enviados: number[] = [];
  private readonly cola: Array<{ prioridad: PrioridadSheets; continuar: () => void; cancelar: () => void }> = [];
  private despertadorPendiente = false;
  private despertador?: ReturnType<typeof setTimeout>;
  private esperas = 0;
  private cancelaciones = 0;

  constructor(
    private readonly maximo: number,
    private readonly reservaInteractiva: number,
    private readonly ventanaMs = 60_000,
    private readonly deps: Dependencias = REALES
  ) {}

  get estado() {
    this.purgar();
    return { enVentana: this.enviados.length, enCola: this.cola.length, esperas: this.esperas, cancelaciones: this.cancelaciones, maximo: this.maximo };
  }

  adquirir(prioridad: PrioridadSheets, senal?: AbortSignal): Promise<void> {
    if (senal?.aborted) return Promise.reject(senal.reason);
    if (this.cola.length === 0 && this.hayHueco(prioridad)) {
      this.enviados.push(this.deps.ahora());
      return Promise.resolve();
    }
    this.esperas++;
    return new Promise<void>((resolve, reject) => {
      const entrada = {
        prioridad,
        continuar: () => { senal?.removeEventListener("abort", entrada.cancelar); resolve(); },
        cancelar: () => {
          const indice = this.cola.indexOf(entrada);
          if (indice >= 0) {
            this.cola.splice(indice, 1);
            this.cancelaciones++;
            if (this.cola.length === 0 && this.despertador) {
              clearTimeout(this.despertador);
              this.despertador = undefined;
              this.despertadorPendiente = false;
            }
          }
          reject(senal?.reason);
        },
      };
      senal?.addEventListener("abort", entrada.cancelar, { once: true });
      if (senal?.aborted) { entrada.cancelar(); return; }
      this.cola.push(entrada);
      this.despachar();
    });
  }

  private purgar(): void {
    const limite = this.deps.ahora() - this.ventanaMs;
    while (this.enviados.length > 0 && this.enviados[0] <= limite) this.enviados.shift();
  }

  private hayHueco(prioridad: PrioridadSheets): boolean {
    this.purgar();
    const tope = prioridad === "fondo" ? Math.max(1, this.maximo - this.reservaInteractiva) : this.maximo;
    return this.enviados.length < tope;
  }

  private despachar(): void {
    // Primero lo interactivo; dentro de cada prioridad, orden de llegada.
    for (const prioridad of ["interactiva", "fondo"] as const) {
      for (;;) {
        const indice = this.cola.findIndex((e) => e.prioridad === prioridad);
        if (indice === -1 || !this.hayHueco(prioridad)) break;
        const [entrada] = this.cola.splice(indice, 1);
        this.enviados.push(this.deps.ahora());
        entrada.continuar();
      }
    }
    if (this.cola.length > 0 && !this.despertadorPendiente) {
      this.despertadorPendiente = true;
      const masAntiguo = this.enviados[0] ?? this.deps.ahora();
      const espera = Math.max(50, masAntiguo + this.ventanaMs - this.deps.ahora() + 5);
      this.despertador = this.deps.programar(() => {
        this.despertador = undefined;
        this.despertadorPendiente = false;
        this.despachar();
      }, espera) || undefined;
    }
  }
}

function entero(valor: string | undefined, porDefecto: number, minimo: number, maximo: number): number {
  const n = Number(valor);
  return Number.isFinite(n) && n >= minimo && n <= maximo ? Math.floor(n) : porDefecto;
}

let limitadores: Record<Tipo, LimitadorVentana> | undefined;
function obtenerLimitadores(): Record<Tipo, LimitadorVentana> {
  // Se leen del entorno en el primer uso real, no al cargar el módulo (ver CLAUDE.md).
  limitadores ??= {
    lectura: new LimitadorVentana(
      entero(process.env.WOBI_SHEETS_MAX_LECTURAS_MIN, 50, 5, 300),
      entero(process.env.WOBI_SHEETS_RESERVA_INTERACTIVA, 15, 0, 100)
    ),
    escritura: new LimitadorVentana(entero(process.env.WOBI_SHEETS_MAX_ESCRITURAS_MIN, 50, 5, 300), 0),
  };
  return limitadores;
}

/**
 * Medición de quién gasta la cuota (caso 2026-10-05: 429 sin saber qué los provocaba). Cada petición que sale a Sheets se
 * anota con su pestaña y el módulo del proyecto que la hizo (sacado de la pila de llamadas), durante 10 minutos. Solo se
 * consulta desde una ruta de administración protegida (`/admin/uso-sheets`): los nombres de pestañas no van a /health.
 */
const VENTANA_USO_MS = 10 * 60_000;

/** Pestaña (o tipo de operación) de una URL de la API de Sheets, con la hoja abreviada. Nunca incluye valores de celdas. */
export function clasificarPeticionSheets(url: string): { hoja: string; destino: string } {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/v4\/spreadsheets\/([^/:]+)(.*)$/);
    if (!m) return { hoja: "?", destino: u.pathname.slice(0, 60) };
    const hoja = m[1].slice(-4);
    const resto = m[2];
    const pestana = (rango: string) => decodeURIComponent(rango).replace(/^'|'$/g, "").split("!")[0].replace(/'$/, "");
    if (resto.startsWith("/values/")) return { hoja, destino: pestana(resto.slice("/values/".length).split(":append")[0].split(":clear")[0]) };
    if (resto.startsWith("/values:batchGet")) {
      const tabs = [...new Set(u.searchParams.getAll("ranges").map(pestana))];
      return { hoja, destino: `batchGet[${tabs.join(",")}]`.slice(0, 120) };
    }
    return { hoja, destino: resto === "" ? "metadatos" : resto.replace(/^[/:]/, "").slice(0, 40) };
  } catch {
    return { hoja: "?", destino: "?" };
  }
}

/** Primer módulo del proyecto (core/, src/, modules/) en una pila de llamadas, ignorando la capa de transporte de Sheets. */
export function origenDesdePila(pila: string): string {
  for (const linea of pila.split("\n")) {
    if (linea.includes("node_modules")) continue; // librerías (gaxios, googleapis): el origen es el código del proyecto
    const m = linea.match(/((?:core|src|modules)\/[^\s:()]+?)\.(?:js|ts)/);
    if (!m) continue;
    if (/limitadorSheets|sheetsReadRetry|sheetsClient|globalOptions|sheetsMetadataCache/.test(m[1])) continue;
    return m[1];
  }
  return "(sin origen)";
}

interface UsoSheets { tipo: Tipo; prioridad: PrioridadSheets; hoja: string; destino: string; origen: string; en: number[] }
const usoSheets = new Map<string, UsoSheets>();

function anotarUsoSheets(tipo: Tipo, prioridad: PrioridadSheets, url: string, ahora = Date.now()): void {
  const { hoja, destino } = clasificarPeticionSheets(url);
  // La pila por defecto (10 marcos) se agota dentro de gaxios/googleapis antes de llegar al código del proyecto.
  const limitePrevio = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const pila = new Error().stack ?? "";
  Error.stackTraceLimit = limitePrevio;
  const origen = origenDesdePila(pila);
  const clave = `${tipo}|${prioridad}|${hoja}|${destino}|${origen}`;
  const registro = usoSheets.get(clave) ?? { tipo, prioridad, hoja, destino, origen, en: [] };
  registro.en.push(ahora);
  usoSheets.set(clave, registro);
  // Poda: se descartan marcas antiguas y claves vacías para que el mapa no crezca sin límite.
  const limite = ahora - VENTANA_USO_MS;
  if (registro.en.length > 200 || usoSheets.size > 300) {
    for (const [k, r] of usoSheets) {
      while (r.en.length > 0 && r.en[0] <= limite) r.en.shift();
      if (r.en.length === 0) usoSheets.delete(k);
    }
  }
}

/** Uso de Sheets de los últimos 10 min agrupado por pestaña y módulo, de mayor a menor (para /admin/uso-sheets). */
export function usoSheetsReciente(ahora = Date.now(), maximo = 40) {
  const limite = ahora - VENTANA_USO_MS;
  const filas = [...usoSheets.values()]
    .map((r) => ({ tipo: r.tipo, prioridad: r.prioridad, hoja: r.hoja, destino: r.destino, origen: r.origen, peticiones: r.en.filter((t) => t > limite).length }))
    .filter((f) => f.peticiones > 0)
    .sort((a, b) => b.peticiones - a.peticiones);
  return {
    ventanaMinutos: VENTANA_USO_MS / 60_000,
    total: filas.reduce((suma, f) => suma + f.peticiones, 0),
    porTipo: { lectura: filas.filter((f) => f.tipo === "lectura").reduce((s, f) => s + f.peticiones, 0), escritura: filas.filter((f) => f.tipo === "escritura").reduce((s, f) => s + f.peticiones, 0) },
    mayores: filas.slice(0, maximo),
  };
}

/** Contadores agregados para diagnóstico (sin datos ni nombres de pestañas). */
export function estadoLimitadorSheets() {
  const l = obtenerLimitadores();
  return { lectura: l.lectura.estado, escritura: l.escritura.estado };
}

export function esPeticionSheets(url: string): boolean {
  try { return new URL(url).hostname === "sheets.googleapis.com"; } catch { return false; }
}

/** Lo mínimo que se usa de las opciones ya preparadas por gaxios. */
interface PeticionGoogle { url?: string | URL; method?: string; timeout?: number; signal?: AbortSignal }
interface RespuestaGoogle { status: number }
export type AdaptadorPorDefecto<O extends PeticionGoogle, R extends RespuestaGoogle> = (opciones: O) => Promise<R>;

interface OpcionesAdaptador {
  limitadores?: Record<Tipo, LimitadorVentana>;
  esperar?: (ms: number) => Promise<void>;
  pausaTras429Ms?: number;
}

/**
 * Adaptador de gaxios con control de cuota. Solo interviene en peticiones a sheets.googleapis.com;
 * el resto (Gmail, Drive, OAuth) pasa intacto al adaptador por defecto.
 */
export function crearAdaptadorSheetsConCuota(opciones: OpcionesAdaptador = {}) {
  const esperar = opciones.esperar ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const pausa = opciones.pausaTras429Ms ?? 20_000;
  return async function adaptadorSheetsConCuota<O extends PeticionGoogle, R extends RespuestaGoogle>(
    peticion: O,
    porDefecto: AdaptadorPorDefecto<O, R>
  ): Promise<R> {
    if (!esPeticionSheets(String(peticion.url ?? ""))) return porDefecto(peticion);

    const tipo: Tipo = (peticion.method ?? "GET").toUpperCase() === "GET" ? "lectura" : "escritura";
    const limitador = (opciones.limitadores ?? obtenerLimitadores())[tipo];
    const prioridad = contextoPrioridad.getStore() ?? "interactiva";
    // Las escrituras pueden tener resultado incierto: no se abortan desde un lector del panel.
    const cancelacion = tipo === "lectura" ? contextoCancelacion.getStore() : undefined;

    for (let intento = 0; ; intento++) {
      await limitador.adquirir(prioridad, cancelacion);
      anotarUsoSheets(tipo, prioridad, String(peticion.url ?? ""));
      // El timeout empieza cuando la petición sale de verdad, no mientras esperaba su turno: el
      // reloj que trae `signal` arrancó antes de entrar en la cola.
      const senales = [cancelacion, peticion.timeout ? AbortSignal.timeout(peticion.timeout) : peticion.signal].filter((s): s is AbortSignal => Boolean(s));
      const enviada = senales.length > 0 ? { ...peticion, signal: senales.length === 1 ? senales[0] : AbortSignal.any(senales) } : peticion;
      const respuesta = await porDefecto(enviada);
      if (respuesta.status !== 429 || tipo !== "lectura" || intento >= 2) return respuesta;
      console.warn(`[sheets/cuota] Google respondió 429 a una lectura pese al limitador (intento ${intento + 1}); reintento en ${pausa / 1000} s.`);
      await esperar(pausa);
    }
  };
}

export const adaptadorSheetsConCuota = crearAdaptadorSheetsConCuota();
