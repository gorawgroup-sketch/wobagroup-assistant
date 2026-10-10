import { randomUUID } from "node:crypto";

/**
 * Contexto de conversación del navegador, EN MEMORIA del servidor. Guarda solo datos estructurados (ids del catálogo, compañías y las
 * opciones que se ofrecieron): jamás el texto de la persona ni el de la respuesta. Una entrada por identidad + dispositivo; el cliente
 * no puede leerla ni fijarla, solo devuelve el `conversacionId` opaco que emite el servidor, y ese id se valida contra la entrada de SU
 * clave: uno ajeno, caducado o inventado se ignora. Se pierde al desplegar (aceptable: la persona repregunta).
 *
 * El contexto nunca concede permisos: quien lo use debe pasar siempre por `resolverDestino` con la identidad de la petición en curso.
 */
export const TTL_CONTEXTO_MS = 10 * 60_000;
const MAX_ENTRADAS = 500;
const MAX_OPCIONES = 4;

export interface OpcionContexto { capabilityId: string; companyId: string; sinFiltro?: boolean }

export interface EstadoConversacion {
  /** Compañía efectiva de la última respuesta (la del texto, la del contexto o la seleccionada). */
  companyId: string;
  /** Compañía que había en el selector del front en la última petición: sirve para detectar que la persona la cambió. */
  companySeleccionada: string;
  /** Último destino resuelto (o el único común a las opciones ofrecidas). */
  capabilityId: string | null;
  /** Opciones de la última aclaración, a las que pueden referirse «el primero», «sí» o «el de Footprint». */
  opciones: OpcionContexto[];
}

interface Entrada extends EstadoConversacion { id: string; ts: number }

export interface AlmacenContexto {
  /** Estado vigente de esa clave SOLO si `conversacionId` es el que se emitió para ella y no ha caducado. */
  obtener(clave: string, conversacionId: unknown): EstadoConversacion | null;
  /** Guarda el estado (renovando la caducidad) y devuelve el `conversacionId` vigente de esa clave. */
  guardar(clave: string, estado: EstadoConversacion, continuaId?: string): string;
  olvidar(clave: string): void;
  /** Solo para pruebas: copia de lo almacenado, para comprobar que no contiene texto. */
  volcar(): Array<{ clave: string } & Entrada>;
}

export function crearAlmacenContexto(opciones: { ahora?: () => number; ttlMs?: number; nuevoId?: () => string } = {}): AlmacenContexto {
  const ahora = opciones.ahora ?? Date.now;
  const ttl = opciones.ttlMs ?? TTL_CONTEXTO_MS;
  const nuevoId = opciones.nuevoId ?? (() => randomUUID().replace(/-/g, ""));
  const entradas = new Map<string, Entrada>();

  const vigente = (e: Entrada): boolean => ahora() - e.ts < ttl;
  const purgar = (): void => {
    for (const [k, e] of entradas) if (!vigente(e)) entradas.delete(k);
    while (entradas.size >= MAX_ENTRADAS) {
      const masAntigua = entradas.keys().next().value as string | undefined;
      if (masAntigua === undefined) break;
      entradas.delete(masAntigua);
    }
  };

  return {
    obtener(clave, conversacionId) {
      const e = entradas.get(clave);
      if (!e) return null;
      if (!vigente(e)) { entradas.delete(clave); return null; }
      if (typeof conversacionId !== "string" || conversacionId !== e.id) return null;
      return { companyId: e.companyId, companySeleccionada: e.companySeleccionada, capabilityId: e.capabilityId, opciones: e.opciones.map((o) => ({ ...o })) };
    },
    guardar(clave, estado, continuaId) {
      const previa = entradas.get(clave);
      const id = previa && vigente(previa) && continuaId !== undefined && previa.id === continuaId ? previa.id : nuevoId();
      entradas.delete(clave); // reinserta al final: el orden del mapa es el de uso reciente
      purgar();
      entradas.set(clave, {
        id, ts: ahora(), companyId: estado.companyId, companySeleccionada: estado.companySeleccionada, capabilityId: estado.capabilityId,
        opciones: estado.opciones.slice(0, MAX_OPCIONES).map((o) => ({ capabilityId: o.capabilityId, companyId: o.companyId, ...(o.sinFiltro ? { sinFiltro: true } : {}) })),
      });
      return id;
    },
    olvidar(clave) { entradas.delete(clave); },
    volcar() { return [...entradas].map(([clave, e]) => ({ clave, ...e, opciones: e.opciones.map((o) => ({ ...o })) })); },
  };
}
