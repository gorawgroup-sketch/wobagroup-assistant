import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Catálogo de navegación de WOBi: UNA sola fuente, la del front (`frontend-cerebro/src/modules/navegador/capabilities.mjs`, que se
 * deriva de `organization.mjs`). El servidor la carga de ese mismo archivo —sin copia manual que pueda divergir— y la versiona.
 * Registrar un área o módulo en el front lo hace descubrible aquí sin tocar este archivo.
 *
 * Es SOLO metadata de navegación: nunca concede acceso. Los permisos los decide `permisos.ts` con la identidad resuelta en servidor.
 */

/**
 * available  = destino implementado y abrible.
 * planned    = área prevista, sin agente conectado (`agente_previsto`).
 * registered = destino PRECISO (sección) registrado en el catálogo cuya vista el front aún no ha implementado (`destino_no_implementado`).
 */
export type EstadoCapacidad = "available" | "planned" | "registered";
/** company = los datos son de la compañía elegida; group = del grupo completo y no se atribuyen a una sola compañía. */
export type AlcanceCapacidad = "company" | "group";
export interface Capacidad {
  id: string;
  label: string;
  description: string;
  status: EstadoCapacidad;
  /** Una sección es un destino preciso DENTRO de un módulo: lleva su área y su módulo, y hereda sus permisos. */
  target: { kind: "area" | "module" | "section"; id: string; area?: string; module?: string };
  companies: string[];
  scope?: AlcanceCapacidad;
}
export interface CatalogoNavegacion {
  /** Huella estable del contenido: cambia si cambia cualquier destino, estado o compañía del catálogo. */
  version: string;
  capacidades: Capacidad[];
  /** Compañías que el catálogo conoce (unión de las de cada capacidad). */
  companias: string[];
}

export const RUTA_CAPACIDADES_FRONT = join(process.cwd(), "frontend-cerebro", "src", "modules", "navegador", "capabilities.mjs");

/** `import()` real aunque el servidor se compile a CommonJS: TypeScript lo convertiría en `require`, que no carga .mjs en todas las versiones. */
const importarEsm = new Function("especificador", "return import(especificador)") as (e: string) => Promise<Record<string, unknown>>;

function texto(v: unknown, campo: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`Catálogo de navegación inválido: «${campo}» no es un texto.`);
  return v;
}

/** Valida estrictamente lo que devuelve el front: cualquier forma inesperada es un error, no una capacidad a medias. */
export function normalizarCapacidades(bruto: unknown): Capacidad[] {
  if (!Array.isArray(bruto) || bruto.length === 0) throw new Error("Catálogo de navegación inválido: no es una lista de capacidades.");
  const ids = new Set<string>();
  return bruto.map((e, i) => {
    if (!e || typeof e !== "object") throw new Error(`Catálogo de navegación inválido: la entrada ${i} no es un objeto.`);
    const r = e as Record<string, unknown>;
    const id = texto(r.id, "id");
    if (ids.has(id)) throw new Error(`Catálogo de navegación inválido: capacidad duplicada «${id}».`);
    ids.add(id);
    const status = r.status;
    if (status !== "available" && status !== "planned" && status !== "registered") throw new Error(`Catálogo de navegación inválido: estado desconocido en «${id}».`);
    const t = r.target as Record<string, unknown> | undefined;
    if (!t || (t.kind !== "area" && t.kind !== "module" && t.kind !== "section")) throw new Error(`Catálogo de navegación inválido: destino desconocido en «${id}».`);
    if (t.kind === "section" && (typeof t.area !== "string" || typeof t.module !== "string" || !id.startsWith(`section:${t.area}:${t.module}:`))) {
      throw new Error(`Catálogo de navegación inválido: la sección «${id}» no indica su área y su módulo.`);
    }
    if (r.scope !== undefined && r.scope !== "company" && r.scope !== "group") throw new Error(`Catálogo de navegación inválido: alcance desconocido en «${id}».`);
    if (!Array.isArray(r.companies) || r.companies.some((c) => typeof c !== "string")) throw new Error(`Catálogo de navegación inválido: compañías de «${id}».`);
    return {
      id, label: texto(r.label, "label"), description: typeof r.description === "string" ? r.description : "", status,
      target: { kind: t.kind, id: texto(t.id, "target.id"), ...(t.kind === "section" ? { area: t.area as string, module: t.module as string } : {}) },
      companies: [...(r.companies as string[])], ...(r.scope ? { scope: r.scope as AlcanceCapacidad } : {}),
    };
  });
}

export function versionDelCatalogo(capacidades: Capacidad[]): string {
  const estable = [...capacidades].sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => [c.id, c.status, c.target.kind, c.target.id, c.target.area ?? null, c.target.module ?? null, c.scope ?? null, [...c.companies].sort()]);
  return `nav-${createHash("sha256").update(JSON.stringify(estable)).digest("hex").slice(0, 12)}`;
}

export function construirCatalogo(capacidades: Capacidad[]): CatalogoNavegacion {
  return { version: versionDelCatalogo(capacidades), capacidades, companias: [...new Set(capacidades.flatMap((c) => c.companies))].sort() };
}

let cache: { clave: string; catalogo: CatalogoNavegacion } | undefined;

/**
 * Carga el catálogo del front. Si el archivo no existe o es inválido LANZA: quien llama responde «no se pudo consultar», nunca un catálogo
 * vacío ni inventado. Solo se cachea mientras el archivo no cambie (fecha de modificación).
 */
export async function cargarCatalogoNavegacion(ruta: string = RUTA_CAPACIDADES_FRONT): Promise<CatalogoNavegacion> {
  const clave = `${ruta}:${statSync(ruta).mtimeMs}`;
  if (cache?.clave === clave) return cache.catalogo;
  const modulo = await importarEsm(`${pathToFileURL(ruta).href}?v=${encodeURIComponent(clave)}`);
  if (typeof modulo.buildCapabilities !== "function") throw new Error("Catálogo de navegación inválido: falta buildCapabilities.");
  const catalogo = construirCatalogo(normalizarCapacidades((modulo.buildCapabilities as () => unknown)()));
  cache = { clave, catalogo };
  return catalogo;
}

export const reiniciarCatalogoParaPruebas = (): void => { cache = undefined; };
