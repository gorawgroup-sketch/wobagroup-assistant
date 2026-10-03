/**
 * Registro EN MEMORIA de lo que hacen las automatizaciones de Holded (últimos eventos con hora), visible en /health. Sirve para ver
 * en segundos qué hace el servidor sin leer la base de datos ni los registros. Solo estados y tiempos: ni cuentas bancarias, ni
 * importes, ni credenciales.
 */
export interface EventoTraza { en: string; evento: string; datos?: Record<string, string | number | boolean | null> }

const MAX_EVENTOS = 80;
const eventos: EventoTraza[] = [];
let enEjecucion: Record<string, string> = {};
const ultimoPorClave: Record<string, EventoTraza> = {};

export function registrarTraza(evento: string, datos?: EventoTraza["datos"], clave?: string): void {
  const e = { en: new Date().toISOString(), evento, datos };
  eventos.push(e);
  if (clave) ultimoPorClave[clave] = e;
  if (eventos.length > MAX_EVENTOS) eventos.splice(0, eventos.length - MAX_EVENTOS);
}

export function marcarEnEjecucion(nombre: string, activa: boolean): void {
  if (activa) enEjecucion[nombre] = new Date().toISOString(); else delete enEjecucion[nombre];
}

export function obtenerTrazaAutomatizacion() {
  return {
    version: (process.env.RAILWAY_GIT_COMMIT_SHA ?? "desconocida").slice(0, 7),
    arranque: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    ahora: new Date().toISOString(),
    enEjecucion: { ...enEjecucion },
    ultimosEventos: eventos.slice(-40),
    /** Último estado conocido de cada elemento con clave (p. ej. cada gasto de la lista aprobada), aunque el historial lo haya desplazado. */
    ultimoPorClave: { ...ultimoPorClave },
  };
}

export function reiniciarTrazaParaPruebas(): void { eventos.length = 0; enEjecucion = {}; for (const k of Object.keys(ultimoPorClave)) delete ultimoPorClave[k]; }
