import { listarPersonas } from "../directorio/directorioPersonasSheet";
import type { Empresa } from "../holded/client";
import { buscarDireccionesPorNombre, type DireccionEncontrada } from "./direccionesEnBuzon";
import { coincideNombre, emailValido, resolverEmailGuardado } from "./titularesSoportesSheet";

/**
 * A qué dirección se le piden los soportes a un titular, por este orden: la que Carlos ya confirmó (se marca sola) → la que
 * encaja de forma inequívoca entre el directorio de personas y el histórico del buzón de Wobi (se propone, sin marcar) → si
 * hay varias, se enumeran para que Carlos elija; nunca se escoge una al azar ni se inventa.
 */

export const DOMINIO_POR_EMPRESA: Partial<Record<Empresa, string>> = { WOBA: "wobagroup.com", Footprint: "footprint.global" };

export type ResolucionEmail =
  | { tipo: "resuelto"; email: string; fuente: "confirmado" | "directorio" | "buzon" }
  | { tipo: "varios"; candidatos: string[] }
  | { tipo: "sugerencias"; candidatos: string[] }
  | { tipo: "nada" };

/** Pura: decide a partir de lo que dicen el directorio y el buzón. */
export function decidirEmailTitular(directorio: string[], buzon: DireccionEncontrada[], dominioPreferido?: string): ResolucionEmail {
  const fuertes = buzon.filter((d) => d.fuerte).map((d) => d.email);
  const todos = [...new Set([...directorio, ...fuertes].map((e) => e.toLowerCase()))];
  if (todos.length === 1) return { tipo: "resuelto", email: todos[0], fuente: directorio.map((e) => e.toLowerCase()).includes(todos[0]) ? "directorio" : "buzon" };
  if (todos.length > 1) {
    const delDominio = dominioPreferido ? todos.filter((e) => e.endsWith(`@${dominioPreferido}`)) : [];
    if (delDominio.length === 1) return { tipo: "resuelto", email: delDominio[0], fuente: "buzon" };
    return { tipo: "varios", candidatos: todos };
  }
  const flojas = [...new Set(buzon.filter((d) => !d.fuerte).map((d) => d.email))];
  return flojas.length ? { tipo: "sugerencias", candidatos: flojas.slice(0, 4) } : { tipo: "nada" };
}

export async function resolverEmailCompleto(nombre: string, empresa: Empresa): Promise<ResolucionEmail> {
  const guardado = await resolverEmailGuardado(nombre);
  if (guardado) return { tipo: "resuelto", email: guardado, fuente: "confirmado" };
  const directorio = (await listarPersonas()).filter((p) => p.email && emailValido(p.email) && coincideNombre(nombre, p.nombre)).map((p) => p.email.trim());
  let buzon: DireccionEncontrada[] = [];
  try {
    buzon = await buscarDireccionesPorNombre(nombre, DOMINIO_POR_EMPRESA[empresa]);
  } catch (error) {
    // Un fallo de Gmail no es un dato: se sigue solo con el directorio y el resumen lo dirá si queda sin resolver.
    console.error("[soportes] No se pudo buscar en el buzón:", error instanceof Error ? error.message : error);
  }
  return decidirEmailTitular(directorio, buzon, DOMINIO_POR_EMPRESA[empresa]);
}
