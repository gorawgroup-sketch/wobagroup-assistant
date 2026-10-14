import { buscarPersonas, listarPersonas } from "../directorio/directorioPersonasSheet";
import { esTitularEmpresa } from "../soportes/cruceExtracto";
import { leerSolicitantes } from "../soportes/solicitudesSoportesSheet";
import { resolverEmailGuardado } from "../soportes/titularesSoportesSheet";
import { agruparPorEmail, emailValido, type Destinatario } from "./destinatarios";

/**
 * Audiencias: de dónde salen las personas a las que se escribe un mismo correo. Un registro abierto — cada módulo que tenga una base de
 * personas la registra con `registrarAudiencia` y el chat puede usarla con «envía este correo a <audiencia>» sin que haya que construir una
 * función nueva por cada pedido. Una audiencia solo devuelve personas con email que consta en un registro del sistema o que dio quien pide
 * el envío; lo que no se puede resolver se informa aparte (`sinEmail`), nunca se adivina.
 */
export interface ResultadoAudiencia { destinatarios: Destinatario[]; sinEmail: string[]; omitidos: string[]; nota?: string }

export interface Audiencia {
  id: string;
  descripcion: string;
  /** Parámetros que acepta, para que quien pide el envío sepa qué pasar. */
  parametros: string;
  resolver(params: Record<string, unknown>): Promise<ResultadoAudiencia>;
}

const registro = new Map<string, Audiencia>();

export function registrarAudiencia(a: Audiencia): void { registro.set(a.id, a); }
export const listarAudiencias = (): Audiencia[] => [...registro.values()];
export const idsAudiencias = (): string[] => [...registro.keys()];

export async function resolverAudiencia(id: string, params: Record<string, unknown> = {}): Promise<ResultadoAudiencia> {
  const a = registro.get(id);
  if (!a) throw new Error(`No existe la audiencia «${id}». Audiencias disponibles: ${idsAudiencias().join(", ")}.`);
  return a.resolver(params);
}

const texto = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Pura: personas que ya recibieron una solicitud de soportes, con su email confirmado. Sin email o sociedad → no se les escribe. */
export async function construirAudienciaSoportes(
  solicitantes: ReadonlyArray<{ empresa: string; titular: string }>,
  resolverEmail: (titular: string) => Promise<string | undefined>,
  empresa?: string
): Promise<ResultadoAudiencia> {
  const items: Array<{ nombre: string; email: string; empresa: string }> = [];
  const sinEmail: string[] = [], omitidos: string[] = [];
  for (const s of solicitantes) {
    if (empresa && s.empresa.toLowerCase() !== empresa.toLowerCase()) continue;
    if (esTitularEmpresa(s.titular)) { if (!omitidos.includes(s.titular)) omitidos.push(s.titular); continue; }
    const email = await resolverEmail(s.titular);
    if (!email) { if (!sinEmail.includes(s.titular)) sinEmail.push(s.titular); continue; }
    items.push({ nombre: s.titular, email, empresa: s.empresa });
  }
  return { destinatarios: agruparPorEmail(items), sinEmail, omitidos };
}

registrarAudiencia({
  id: "solicitud_soportes",
  descripcion: "Personas a las que ya se les pidieron soportes (facturas o recibos de gastos con tarjeta), con su email confirmado. Una persona = un correo, aunque se le pidiera en varias empresas.",
  parametros: "empresa (opcional: WOBA, EWORKS o Footprint)",
  resolver: async (p) => construirAudienciaSoportes(await leerSolicitantes(), resolverEmailGuardado, texto(p.empresa) || undefined),
});

registrarAudiencia({
  id: "directorio",
  descripcion: "Personas del directorio de contactos del buzón de Wobi (quienes han escrito o a quienes se ha escrito), filtradas por texto del nombre o email y/o por dominio.",
  parametros: "consulta (texto del nombre o email) y/o dominio (por ejemplo «footprint.global»); hace falta al menos uno",
  resolver: async (p) => {
    const consulta = texto(p.consulta), dominio = texto(p.dominio).replace(/^@/, "").toLowerCase();
    if (!consulta && !dominio) throw new Error("La audiencia «directorio» necesita una consulta (texto del nombre o email) o un dominio.");
    const personas = consulta ? await buscarPersonas(consulta) : await listarPersonas();
    const filtradas = dominio ? personas.filter((x) => x.email.toLowerCase().endsWith(`@${dominio}`)) : personas;
    return { destinatarios: agruparPorEmail(filtradas.map((x) => ({ nombre: x.nombre, email: x.email }))), sinEmail: [], omitidos: [] };
  },
});

registrarAudiencia({
  id: "lista",
  descripcion: "Una lista que da quien pide el envío (nombres y emails escritos en la orden).",
  parametros: "destinatarios: lista de { nombre, email }",
  resolver: async (p) => {
    const bruto = Array.isArray(p.destinatarios) ? p.destinatarios : [];
    const validos: Array<{ nombre: string; email: string }> = [], invalidos: string[] = [];
    for (const d of bruto) {
      const o = (d ?? {}) as Record<string, unknown>;
      const email = texto(o.email), nombre = texto(o.nombre);
      if (emailValido(email)) validos.push({ nombre, email }); else invalidos.push(nombre || email || "(vacío)");
    }
    return { destinatarios: agruparPorEmail(validos), sinEmail: invalidos, omitidos: [] };
  },
});
