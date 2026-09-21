/** Receipt service geography, shared by manual and automatic contact resolution.
 * Never infer geography from the card currency, traveller or historical aliases.
 */
const normalizar = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const paises: Record<string, string[]> = {
  Colombia: ["colombia", "bogota", "medellin"],
  Mexico: ["mexico", "ciudad de mexico", "cdmx", "monterrey", "cancun"],
  Spain: ["spain", "espana", "madrid", "barcelona"],
  "Costa Rica": ["costa rica", "curridabat"],
  "Puerto Rico": ["puerto rico"], Panama: ["panama"],
  Portugal: ["portugal", "lisboa", "lisbon"],
  Netherlands: ["netherlands", "paises bajos", "holanda", "amsterdam", "rotterdam", "breda"],
  France: ["france", "francia", "paris"], Germany: ["germany", "alemania", "berlin"],
  Belgium: ["belgium", "belgica", "brussels", "bruselas"],
  Italy: ["italy", "italia"], Brazil: ["brazil", "brasil"],
  Argentina: ["argentina", "buenos aires"], Chile: ["chile", "santiago de chile"],
  Peru: ["peru"], Ecuador: ["ecuador", "quito"],
  "United States": ["united states", "estados unidos", "usa"],
  "United Kingdom": ["united kingdom", "reino unido", "london", "londres"],
  Canada: ["canada"], Uruguay: ["uruguay", "montevideo"],
};
function paisesEn(texto: string): string[] {
  const t = ` ${normalizar(texto)} `;
  return Object.entries(paises).filter(([, pistas]) => pistas.some(p => t.includes(` ${p} `))).map(([pais]) => pais);
}
export function esProveedorUber(nombre: string): boolean {
  const n = normalizar(nombre);
  return /^uber(?: |$)/.test(n) && !/\b(eats|freight)\b/.test(n);
}
export function destinoProveedorUber(nombre: string, concepto = ""): string | undefined {
  if (!esProveedorUber(nombre)) return undefined;
  const servicio = paisesEn(concepto);
  // The route takes precedence over a multinational's legal issuer address.
  if (servicio.length === 1) return servicio[0];
  if (servicio.length > 1) return "generico";
  // A bare brand-country name is meaningful; a legal issuer such as Uber
  // Systems Spain / Uber B.V. is not proof of where the ride occurred.
  const proveedor = paisesEn(nombre);
  const bare = normalizar(nombre).replace(/^uber /, "");
  return proveedor.length === 1 && paises[proveedor[0]].includes(bare) ? proveedor[0] : "generico";
}
export function seleccionarContactoUber<T extends { id?: unknown; name?: unknown; archived?: unknown }>(
  contactos: T[], nombre: string, concepto = ""
): T | undefined {
  const destino = destinoProveedorUber(nombre, concepto);
  if (!destino) return undefined;
  const candidatos = contactos.filter(c => typeof c.name === "string" && c.archived !== true &&
    (destino === "generico" ? normalizar(c.name) === "uber" :
      esProveedorUber(c.name) && paisesEn(c.name).length === 1 && paisesEn(c.name)[0] === destino));
  const unicos = [...new Map(candidatos.filter(c => typeof c.id === "string").map(c => [c.id, c])).values()];
  return unicos.length === 1 ? unicos[0] : undefined;
}
export const INSTRUCCION_GEOGRAFIA_UBER = "Para un trayecto Uber, conserva en el concepto el origen, destino, localidad, país del SERVICIO y distancia cuando sean legibles en el recibo. Solo deduce el país si las ubicaciones lo identifican inequívocamente; no lo deduzcas de la moneda, del viajero ni del domicilio fiscal del emisor. No añadas un país si no hay evidencia o hay contradicción. No confundas Uber Eats con transporte.";

/** Carlos explicitly authorized reusing either duplicate Uber Eats contact.
 * Stable ID ordering keeps every retry on the same existing contact.
 */
export function esProveedorUberEats(nombre: string): boolean { return normalizar(nombre) === "uber eats"; }
export function seleccionarContactoUberEats<T extends { id?: unknown; name?: unknown; archived?: unknown }>(contactos: T[], nombre: string): T | undefined {
  if (!esProveedorUberEats(nombre)) return undefined;
  return contactos.filter(c => typeof c.id === "string" && typeof c.name === "string" &&
    c.archived !== true && esProveedorUberEats(c.name)).sort((a,b) => String(a.id).localeCompare(String(b.id)))[0];
}
