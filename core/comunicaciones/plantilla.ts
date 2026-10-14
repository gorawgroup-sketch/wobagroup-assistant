/**
 * Plantilla de un correo a varias personas: el texto lo redacta quien pide el envío (el chat, siguiendo la orden) y puede llevar
 * marcas que se sustituyen por destinatario. Lógica pura: nada se envía aquí.
 *   {nombre}          nombre de pila («Yessenia»)
 *   {nombre_completo} nombre tal como consta
 *   {empresas}        «Footprint y WOBA», las empresas por las que está en la audiencia (si la audiencia las conoce)
 *   {detalle}         texto propio de cada persona que da la audiencia (lo que se le pide a ella en concreto)
 */
export interface DatosPlantilla { nombre: string; empresas: string[]; detalle?: string }

export const MARCAS_PLANTILLA = ["nombre", "nombre_completo", "empresas", "detalle"] as const;

const MARCA = /\{([a-z_]+)\}/gi;

export function marcasDesconocidas(texto: string): string[] {
  const conocidas = new Set<string>(MARCAS_PLANTILLA);
  return [...new Set([...texto.matchAll(MARCA)].map((m) => m[1].toLowerCase()).filter((m) => !conocidas.has(m)))];
}

export function nombreDePila(nombreCompleto: string): string {
  const p = nombreCompleto.trim().split(/\s+/).filter(Boolean)[0];
  return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : "";
}

export function listaEmpresas(empresas: readonly string[]): string {
  return empresas.length <= 1 ? (empresas[0] ?? "") : `${empresas.slice(0, -1).join(", ")} y ${empresas[empresas.length - 1]}`;
}

export function renderizar(texto: string, d: DatosPlantilla): string {
  return texto.replace(MARCA, (entera, marca: string) => {
    switch (marca.toLowerCase()) {
      case "nombre": return nombreDePila(d.nombre) || d.nombre;
      case "nombre_completo": return d.nombre;
      case "empresas": return listaEmpresas(d.empresas);
      case "detalle": return d.detalle ?? "";
      default: return entera;
    }
  });
}
