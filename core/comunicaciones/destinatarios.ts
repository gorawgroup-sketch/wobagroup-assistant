import { claveTitular } from "../soportes/cruceExtracto";

/**
 * Una persona de una audiencia: nombre, email y las empresas por las que está en ella (si la audiencia las conoce). El email siempre sale
 * de un registro del sistema o de lo que dio quien pide el envío; nunca se inventa ni se adivina.
 */
/** `detalle`: texto propio de esta persona que la plantilla coloca donde ponga {detalle} (por ejemplo, lo que se le pide a ella en concreto). */
export interface Destinatario { nombre: string; email: string; empresas: string[]; detalle?: string }

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
export const emailValido = (email: string): boolean => EMAIL.test(email.trim());

/** ¿Este nombre es alguno de los excluidos? Por palabras (mínimo dos): «Carlos Gonzalez» excluye a «Carlos Alberto Gonzalez Guerrero»; «Carlos» solo no excluye a nadie. */
export function estaExcluido(nombre: string, excluir: readonly string[]): boolean {
  const t = new Set(claveTitular(nombre).split(" ").filter(Boolean));
  return excluir.some((e) => {
    const palabras = claveTitular(e).split(" ").filter(Boolean);
    return palabras.length >= 2 && palabras.every((p) => t.has(p));
  });
}

/** Una persona = un correo: se agrupa por email (nunca por nombre, que puede venir escrito distinto) y se juntan sus empresas. */
export function agruparPorEmail(items: ReadonlyArray<{ nombre: string; email: string; empresa?: string; detalle?: string }>): Destinatario[] {
  const porEmail = new Map<string, Destinatario>();
  for (const i of items) {
    const email = i.email.trim().toLowerCase();
    if (!emailValido(email)) continue;
    const previo = porEmail.get(email);
    if (previo) {
      if (i.empresa && !previo.empresas.includes(i.empresa)) previo.empresas.push(i.empresa);
      if (i.detalle && !(previo.detalle ?? "").includes(i.detalle)) previo.detalle = previo.detalle ? `${previo.detalle}\n${i.detalle}` : i.detalle;
    } else porEmail.set(email, { nombre: i.nombre.trim() || email.split("@")[0], email, empresas: i.empresa ? [i.empresa] : [], ...(i.detalle ? { detalle: i.detalle } : {}) });
  }
  const lista = [...porEmail.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  for (const d of lista) d.empresas.sort();
  return lista;
}

export function aplicarExclusiones(destinatarios: Destinatario[], excluir: readonly string[]): { quedan: Destinatario[]; excluidos: string[] } {
  const excluidos: string[] = [];
  const quedan = destinatarios.filter((d) => { if (estaExcluido(d.nombre, excluir)) { excluidos.push(d.nombre); return false; } return true; });
  return { quedan, excluidos };
}
