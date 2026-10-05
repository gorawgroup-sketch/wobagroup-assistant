/**
 * Correos de aseguradoras y corredurías que llegan al buzón del asistente.
 *
 * Es una LECTURA determinista (sin modelo, sin marcar nada como leído): busca mensajes de remitentes de seguros,
 * los resume y marca las señales que importan para decidir si Carlos tiene algo que hacer. No interpreta ni
 * contesta correos —eso sigue siendo del flujo de correo y de Carlos— y los documentos adjuntos ya los archiva y
 * lee el canal de pólizas (core/seguros/integrarDocumentoPoliza.ts) cuando pasan por el correo normal.
 *
 * El filtro por remitente se aplica DOS veces: en la búsqueda de Gmail y, otra vez, sobre la dirección real
 * (nunca el nombre visible, que cualquiera puede rellenar con lo que quiera).
 */
import { normalizarTexto } from "./contrapartes";

/** Dominios de las aseguradoras y corredurías con las que trabajamos (Acodrid/Espabrok, Markel, Allianz). */
export const DOMINIOS_SEGUROS = [
  "acodrid.com",
  "espabrok.es",
  "markelintl.es",
  "markel.com",
  "markel.es",
  "markel.com.es",
  "allianz.es",
  "allianz.com",
] as const;

export type SenalCorreo = "incidencia" | "recibo" | "documento" | "firma";

export interface CorreoSeguro {
  id: string;
  threadId: string;
  /** Fecha del correo en ISO (UTC). */
  fecha: string;
  remitente: string;
  asunto: string;
  extracto: string;
  adjuntos: string[];
  senales: SenalCorreo[];
}

export interface ResumenCorreoCrudo {
  id: string;
  threadId: string;
  de: string;
  asunto: string;
  fecha: string;
  extracto: string;
  adjuntos: Array<{ filename: string }>;
}

export interface FuentesCorreo {
  buscarMensajes(consulta: string, maximo: number): Promise<string[]>;
  obtenerResumenCorreo(id: string): Promise<ResumenCorreoCrudo>;
}

/** Dirección real de un encabezado «Nombre <correo@dominio>» (o el texto tal cual si no trae ángulos). */
export function direccionDe(de: string): string {
  const entreAngulos = de.match(/<([^>]+)>/);
  return (entreAngulos ? entreAngulos[1] : de).trim().toLowerCase();
}

export function esRemitenteDeSeguros(de: string): boolean {
  const direccion = direccionDe(de);
  const arroba = direccion.lastIndexOf("@");
  if (arroba < 0) return false;
  const dominio = direccion.slice(arroba + 1);
  return DOMINIOS_SEGUROS.some((d) => dominio === d || dominio.endsWith(`.${d}`));
}

/** Consulta de Gmail para los remitentes de seguros desde una fecha YYYY-MM-DD. */
export function consultaGmailSeguros(desde: string): string {
  return `from:(${DOMINIOS_SEGUROS.join(" OR ")}) after:${desde.replace(/-/g, "/")}`;
}

const PATRON_INCIDENCIA =
  /\b(urgente|devuelt\w*|impag\w*|reclam\w*|requerimiento|suspens\w*|anulaci\w*|cancelaci\w*|rescis\w*|rechaz\w*|vencid\w*|embargo|extinci\w*)\b|ultimo aviso|sin cobertura|recibos? pendientes?/;
const PATRON_RECIBO = /\b(recibos?|justificantes?|pago|cobro|transferencia|abono|liquidaci\w*)\b/;
const PATRON_DOCUMENTO = /suplemento|condiciones|poliza|certificad|anexo|carta|cotizaci|presupuesto|propuesta|duplicado/;
const PATRON_FIRMA = /\b(firmad\w*|firmar|firma)\b/;

export function senalesDeCorreo(asunto: string, extracto: string, adjuntos: string[]): SenalCorreo[] {
  const texto = normalizarTexto(`${asunto} ${extracto}`);
  const senales: SenalCorreo[] = [];
  if (PATRON_INCIDENCIA.test(texto)) senales.push("incidencia");
  if (PATRON_RECIBO.test(texto)) senales.push("recibo");
  if (adjuntos.some((a) => PATRON_DOCUMENTO.test(normalizarTexto(a)))) senales.push("documento");
  if (PATRON_FIRMA.test(texto)) senales.push("firma");
  return senales;
}

function aIso(fecha: string): string {
  const d = new Date(fecha);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const MAX_CORREOS_POR_REVISION = 40;

/** Correos de seguros recibidos desde `desde` (YYYY-MM-DD), de más antiguo a más reciente. */
export async function leerCorreosDeSeguros(desde: string, fuentes: FuentesCorreo): Promise<CorreoSeguro[]> {
  const ids = await fuentes.buscarMensajes(consultaGmailSeguros(desde), MAX_CORREOS_POR_REVISION);
  const correos: CorreoSeguro[] = [];
  for (const id of ids) {
    const r = await fuentes.obtenerResumenCorreo(id);
    if (!esRemitenteDeSeguros(r.de)) continue;
    const adjuntos = r.adjuntos.map((a) => a.filename).filter(Boolean);
    correos.push({
      id: r.id,
      threadId: r.threadId,
      fecha: aIso(r.fecha),
      remitente: r.de.replace(/<[^>]*>/, "").replace(/"/g, "").trim() || direccionDe(r.de),
      asunto: r.asunto,
      extracto: r.extracto,
      adjuntos,
      senales: senalesDeCorreo(r.asunto, r.extracto, adjuntos),
    });
  }
  return correos.sort((a, b) => a.fecha.localeCompare(b.fecha));
}
