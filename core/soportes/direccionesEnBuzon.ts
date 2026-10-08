import type { gmail_v1 } from "googleapis";
import { getGmailClient } from "../gmail/client";
import { claveTitular } from "./cruceExtracto";

/**
 * Busca en el buzón de Wobi (asistente@wobagroup.com) las direcciones con las que una persona ha escrito o a las que se le
 * ha escrito. El directorio de personas solo se alimenta de correos nuevos; el histórico del buzón ya tiene a casi todos.
 * Solo lectura: nunca marca, mueve ni envía nada.
 */

export interface DireccionEncontrada {
  email: string;
  /** true: el nombre visto o la dirección comparten al menos dos palabras con la persona. false: solo una (sugerencia). */
  fuerte: boolean;
  nombreVisto: string;
  /** Veces que esa dirección ESCRIBIÓ (From): es la prueba más fuerte de que es la que la persona usa. */
  comoRemitente: number;
  /** Veces que aparece como destinatario o en copia. */
  comoDestinatario: number;
}

const PROPIAS = /^(asistente|noreply|no-reply|donotreply|notifications?|mailer-daemon)@/i;
const palabras = (t: string): string[] => claveTitular(t).split(" ").filter((w) => w.length > 1);

/** Lista de direcciones de un header («Nombre <a@b>, otro@c»). Pura. */
export function direccionesDeHeader(valor: string): Array<{ nombre: string; email: string }> {
  const salida: Array<{ nombre: string; email: string }> = [];
  for (const parte of valor.match(/(?:"[^"]*"|[^,"])+/g) ?? []) {
    const m = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(parte) ?? /^\s*()([^<>\s,;]+@[^<>\s,;]+)\s*$/.exec(parte);
    if (m) salida.push({ nombre: m[1].replace(/^["']|["']$/g, "").trim(), email: m[2].toLowerCase() });
  }
  return salida;
}

/** ¿Encaja esta dirección con la persona? Dos o más palabras del nombre en el nombre visto, o en la parte local del email. Pura. */
export function encajaConPersona(buscada: string, nombreVisto: string, email: string): boolean {
  const b = palabras(buscada);
  const local = claveTitular(email.split("@")[0].replace(/[._-]+/g, " "));
  const visto = new Set([...palabras(nombreVisto), ...local.split(" ")]);
  const comunes = b.filter((w) => visto.has(w) || [...visto].some((v) => v.length > 3 && (w.startsWith(v) || v.startsWith(w))));
  return comunes.length >= 2;
}

function consultas(nombre: string): string[] {
  const p = nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter((w) => w.length > 1);
  if (p.length === 0) return [];
  const pares = new Set<string>();
  if (p.length >= 2) {
    for (let j = 1; j < p.length; j++) pares.add(`${p[0]} ${p[j]}`);
    pares.add(`${p[p.length - 2]} ${p[p.length - 1]}`);
  } else pares.add(p[0]);
  return [...pares].map((q) => `{from:(${q}) to:(${q}) cc:(${q})}`);
}

/** Consultas de una sola palabra (nombre de pila y primer apellido), solo para SUGERIR cuando no hay coincidencia fuerte. */
function consultasFlojas(nombre: string): string[] {
  const p = nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter((w) => w.length > 2);
  return [...new Set([p[0], p[p.length - 1]].filter(Boolean))].map((q) => `{from:${q} to:${q} cc:${q}}`);
}

const HEADERS = ["From", "To", "Cc", "Reply-To"];

async function reunir(nombre: string, qs: string[], max: number, aceptar: (nombreVisto: string, email: string) => boolean, fuerte: boolean): Promise<DireccionEncontrada[]> {
  const gmail = getGmailClient();
  const ids = new Set<string>();
  for (const q of qs) {
    const r = await gmail.users.messages.list({ userId: "me", q, maxResults: max });
    for (const m of r.data.messages ?? []) if (m.id) ids.add(m.id);
  }
  const cuentas = new Map<string, DireccionEncontrada>();
  for (const id of ids) {
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: HEADERS });
    const h = (n: string): string => (msg.data.payload?.headers as gmail_v1.Schema$MessagePartHeader[] | undefined)?.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
    for (const nombreHeader of HEADERS) {
      for (const d of direccionesDeHeader(h(nombreHeader))) {
        if (PROPIAS.test(d.email) || !aceptar(d.nombre, d.email)) continue;
        const previa = cuentas.get(d.email) ?? { email: d.email, fuerte, nombreVisto: d.nombre, comoRemitente: 0, comoDestinatario: 0 };
        if (nombreHeader === "From") previa.comoRemitente++; else previa.comoDestinatario++;
        if (!previa.nombreVisto && d.nombre) previa.nombreVisto = d.nombre;
        cuentas.set(d.email, previa);
      }
    }
  }
  return [...cuentas.values()].sort((a, b) => b.comoRemitente - a.comoRemitente || b.comoDestinatario - a.comoDestinatario);
}

/** Palabra suelta de la persona en el nombre visto o en la parte local de la dirección (solo para sugerir). */
function coincidenciaFloja(buscada: string, nombreVisto: string, email: string): boolean {
  const b = palabras(buscada).filter((w) => w.length > 2);
  const local = claveTitular(email.split("@")[0].replace(/[._-]+/g, " ")).split(" ");
  const visto = new Set([...palabras(nombreVisto), ...local]);
  return b.some((w) => visto.has(w) || [...visto].some((v) => v.length > 3 && (w.startsWith(v) || v.startsWith(w))));
}

/**
 * Direcciones del buzón que encajan con el nombre. Primero las fuertes (dos palabras en común); si no hay ninguna, las
 * sugerencias flojas (una palabra, p. ej. un destinatario que solo aparece como «alberto@…» sin nombre visible), marcadas
 * `fuerte: false` para que NUNCA se usen sin que alguien las confirme.
 */
export async function buscarDireccionesPorNombre(nombre: string, dominioPreferido?: string, maxMensajesPorConsulta = 12): Promise<DireccionEncontrada[]> {
  const fuertes = await reunir(nombre, consultas(nombre), maxMensajesPorConsulta, (v, e) => encajaConPersona(nombre, v, e), true);
  if (fuertes.length > 0) {
    // La misma persona suele tener una dirección por empresa (alberto@wobagroup.com y alberto@footprint.global) y la del
    // dominio de la empresa de la campaña puede no aparecer con su nombre: se prueba la misma parte local en ese dominio.
    if (dominioPreferido && !fuertes.some((d) => d.email.endsWith(`@${dominioPreferido}`))) {
      const gmail = getGmailClient();
      for (const local of new Set(fuertes.slice(0, 2).map((d) => d.email.split("@")[0]))) {
        const direccion = `${local}@${dominioPreferido}`;
        const r = await gmail.users.messages.list({ userId: "me", q: `{from:${direccion} to:${direccion} cc:${direccion}}`, maxResults: 3 });
        if ((r.data.messages ?? []).length > 0) fuertes.push({ email: direccion, fuerte: true, nombreVisto: fuertes[0].nombreVisto, comoRemitente: 0, comoDestinatario: r.data.messages!.length });
      }
    }
    return fuertes;
  }
  return reunir(nombre, consultasFlojas(nombre), maxMensajesPorConsulta, (v, e) => coincidenciaFloja(nombre, v, e), false);
}
