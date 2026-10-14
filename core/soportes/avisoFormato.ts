import { claveTitular, esTitularEmpresa } from "./cruceExtracto";
import { BUZON_SOPORTES, INSTRUCCIONES_ENVIO_SOPORTES, nombreDePila } from "./redactarCorreoSoportes";

/**
 * Aviso de FORMATO a quienes ya recibieron una solicitud de soportes (pedido de Carlos, 2026-10-14): agradecer a quien ya los envió y
 * explicar a quien no cómo enviarlos, porque muchos respondían al correo de la solicitud en vez de mandar cada soporte aparte, con el
 * detalle del gasto en el asunto. Texto FIJO, sin IA. Lógica pura (destinatarios y redacción); el envío y los botones viven en
 * avisoFormatoTelegram.ts y nada sale sin que un superadministrador pulse «Enviar».
 */
export const ASUNTO_AVISO_FORMATO = "Soportes de tus gastos con tarjeta · Gracias y cómo enviarlos";

export interface DestinatarioAviso { titular: string; email: string; empresas: string[] }

export interface DatosAviso { titular: string; empresas: string[]; hojaUrl?: string }

const listaEmpresas = (empresas: readonly string[]): string => empresas.length <= 1 ? (empresas[0] ?? "") : `${empresas.slice(0, -1).join(", ")} y ${empresas[empresas.length - 1]}`;

export function redactarAvisoFormato(d: DatosAviso): string {
  const empresas = listaEmpresas(d.empresas);
  return [
    `Hola, ${nombreDePila(d.titular) || d.titular}:`,
    "",
    `Hace unos días te escribimos desde ${BUZON_SOPORTES} para pedirte los soportes (facturas o recibos) de tus gastos con tarjeta${empresas ? ` de ${empresas}` : ""}. ` +
      "Te agradecemos mucho tu atención, y más aún si ya los enviaste.",
    "",
    "Para que nuestro asistente pueda leerlos y conciliarlos sin errores, te pedimos que los envíes así:",
    ...INSTRUCCIONES_ENVIO_SOPORTES.map((t, i) => `${i + 1}. ${t}`),
    "",
    "Si ya enviaste algún soporte, no hace falta que lo reenvíes" + (d.hojaUrl
      ? `: indícalo en la columna «Comment» de tu hoja de seguimiento (${d.hojaUrl}), con la fecha y el destinatario, y lo localizamos nosotros primero.`
      : ": respóndenos con la fecha y el destinatario de ese envío y lo localizamos nosotros primero."),
    "Si algún cargo no lo reconoces o corresponde a otra persona, cuéntanoslo para revisarlo.",
    "",
    "Gracias por tu colaboración.",
  ].join("\n");
}

const normalizar = (t: string): string => claveTitular(t);

/** ¿Este titular es alguno de los excluidos por nombre? Coincidencia por palabras: «Carlos Gonzalez» excluye a «Carlos Alberto Gonzalez Guerrero». */
export function estaExcluido(titular: string, excluir: readonly string[]): boolean {
  const t = new Set(normalizar(titular).split(" ").filter(Boolean));
  return excluir.some((e) => {
    const palabras = normalizar(e).split(" ").filter(Boolean);
    return palabras.length >= 2 && palabras.every((p) => t.has(p));
  });
}

export interface ResultadoDestinatarios { destinatarios: DestinatarioAviso[]; sinEmail: string[]; excluidos: string[]; sociedades: string[] }

/**
 * Una persona = un correo, aunque se le haya pedido en varias empresas (se agrupa por email, nunca por nombre: el mismo titular puede
 * aparecer escrito distinto). Sin email confirmado no se escribe a nadie (nunca se adivina una dirección). Las sociedades no son destinatarios.
 */
export async function agruparDestinatarios(
  solicitantes: ReadonlyArray<{ empresa: string; titular: string }>,
  resolverEmail: (titular: string) => Promise<string | undefined>,
  excluir: readonly string[] = []
): Promise<ResultadoDestinatarios> {
  const porEmail = new Map<string, DestinatarioAviso>();
  const sinEmail: string[] = [], excluidos: string[] = [], sociedades: string[] = [];
  for (const s of solicitantes) {
    if (esTitularEmpresa(s.titular)) { if (!sociedades.includes(s.titular)) sociedades.push(s.titular); continue; }
    if (estaExcluido(s.titular, excluir)) { if (!excluidos.includes(s.titular)) excluidos.push(s.titular); continue; }
    const email = (await resolverEmail(s.titular))?.trim().toLowerCase();
    if (!email) { if (!sinEmail.includes(s.titular)) sinEmail.push(s.titular); continue; }
    const previo = porEmail.get(email);
    if (previo) { if (!previo.empresas.includes(s.empresa)) previo.empresas.push(s.empresa); }
    else porEmail.set(email, { titular: s.titular, email, empresas: [s.empresa] });
  }
  const destinatarios = [...porEmail.values()].sort((a, b) => a.titular.localeCompare(b.titular));
  for (const d of destinatarios) d.empresas.sort();
  return { destinatarios, sinEmail, excluidos, sociedades };
}
