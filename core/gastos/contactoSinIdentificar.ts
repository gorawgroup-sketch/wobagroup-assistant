import { holdedGet, type Empresa } from "../holded/client";
import { crearContactoHolded } from "../holded/write";

type Contacto = { id: string; name: string; archived?: boolean };
const normalizar = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const nombresGenericos = new Set([
  "proveedor sin identificar",
  "sin identificar (ticket sin nombre de establecimiento visible)",
]);
export function esContactoGenericoAutorizado(c: Contacto): boolean {
  return Boolean(c.id) && c.archived !== true && nombresGenericos.has(normalizar(c.name));
}
export async function obtenerContactoSinIdentificar(
  empresa: Empresa,
  get: typeof holdedGet = holdedGet,
  crear: typeof crearContactoHolded = crearContactoHolded
): Promise<Contacto> {
  const contactos: Contacto[] = [];
  const cursores = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const pagina = await get<{items: Contacto[];has_more:boolean;cursor?:string}>(empresa,"/contacts",{limit:"200",cursor});
    if (!Array.isArray(pagina.items)) throw new Error("No se pudo verificar el contacto genérico.");
    contactos.push(...pagina.items.filter(esContactoGenericoAutorizado));
    if (pagina.has_more === false) break;
    if (!pagina.cursor || cursores.has(pagina.cursor) || cursores.size >= 100) throw new Error("Listado de contactos incompleto.");
    cursor = pagina.cursor; cursores.add(cursor);
  }
  const unicos = [...new Map(contactos.map(c=>[c.id,c])).values()];
  if (unicos.length > 1) throw new Error("Hay varios contactos genéricos; no se elegirá uno arbitrariamente.");
  const elegido = unicos[0] ?? await crear(empresa,"PROVEEDOR SIN IDENTIFICAR");
  // También valida los resultados durables: un contacto pudo ser renombrado en Holded.
  const actual = await get<Contacto>(empresa,`/contacts/${encodeURIComponent(elegido.id)}`);
  if (actual.id !== elegido.id || !esContactoGenericoAutorizado(actual)) throw new Error("El contacto genérico cambió de identidad; no se creó el gasto.");
  return actual;
}
