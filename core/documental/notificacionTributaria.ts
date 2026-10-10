/**
 * Incidencia #7 (09-09-2026, correo de Alberto «dos notificaciones hacienda C.P.E.»): de dos PDF de la AEAT para EWORKS, la
 * providencia de apremio (747,31 €) se archivó bien en «REQUERIMIENTOS HACIENDA» y la sanción tributaria (137,62 €) salió
 * como propuesta de GASTO en Holded. La regla ya estaba en la base de conocimiento, pero solo como texto que el modelo
 * podía ignorar. Aquí es determinista: una notificación de la AEAT o de la Seguridad Social (sanción, providencia de
 * apremio, requerimiento, liquidación, diligencia de embargo) NUNCA es un gasto a crear; se archiva en la carpeta de
 * requerimientos de su empresa y se revisa e informa. Lógica pura, sin IA.
 */
export interface PistasNotificacionTributaria {
  proveedor?: string;
  concepto?: string;
  numero?: string;
  nombreArchivo?: string;
  texto?: string;
}

export interface NotificacionTributaria {
  organismo: "AEAT" | "TGSS";
  tipo: "sanción" | "providencia de apremio" | "requerimiento" | "liquidación" | "diligencia de embargo" | "notificación";
  razon: string;
}

const ORGANISMO_AEAT = /agencia\s+(estatal\s+de\s+administraci[oó]n\s+)?tributaria|\bAEAT\b|hacienda\s+p[uú]blica|dependencia\s+regional\s+de\s+recaudaci[oó]n|delegaci[oó]n\s+(especial\s+)?de\s+la\s+AEAT|\bQ2826000H\b/i;
const ORGANISMO_TGSS = /tesorer[ií]a\s+general\s+de\s+la\s+seguridad\s+social|\bTGSS\b|seguridad\s+social/i;
const TIPOS: Array<{ tipo: NotificacionTributaria["tipo"]; re: RegExp }> = [
  { tipo: "providencia de apremio", re: /providencia\s+de\s+apremio|recargo\s+de\s+apremio|per[ií]odo\s+ejecutivo/i },
  { tipo: "diligencia de embargo", re: /diligencia\s+de\s+embargo|embargo\s+de\s+(cuentas|cr[eé]ditos|sueldos)/i },
  { tipo: "sanción", re: /sanci[oó]n\s+tributaria|acuerdo\s+de\s+imposici[oó]n\s+de\s+sanci[oó]n|expediente\s+sancionador|art(?:[ií]culo|\.)?\s*19[1-9]\s*(?:de\s+la\s+)?LGT|\bLGT\b/i },
  { tipo: "requerimiento", re: /requerimiento/i },
  { tipo: "liquidación", re: /liquidaci[oó]n\s+(provisional|definitiva)|propuesta\s+de\s+liquidaci[oó]n|acuerdo\s+de\s+liquidaci[oó]n/i },
];

/** undefined si no es una notificación tributaria; si lo es, el organismo, el tipo y por qué. */
export function detectarNotificacionTributaria(p: PistasNotificacionTributaria): NotificacionTributaria | undefined {
  const cabecera = [p.proveedor, p.concepto, p.numero, p.nombreArchivo].filter(Boolean).join(" · ");
  const todo = [cabecera, p.texto].filter(Boolean).join("\n");
  const organismo: NotificacionTributaria["organismo"] | undefined =
    ORGANISMO_AEAT.test(todo) ? "AEAT" : ORGANISMO_TGSS.test(todo) ? "TGSS" : undefined;
  const tipo = TIPOS.find((t) => t.re.test(todo))?.tipo;
  // Hace falta el organismo (en proveedor, concepto, número o texto) y, o bien un tipo de acto administrativo reconocible,
  // o bien que el «proveedor» sea directamente el organismo (una Administración no emite facturas de gasto a estas sociedades).
  const proveedorEsOrganismo = Boolean(p.proveedor && (ORGANISMO_AEAT.test(p.proveedor) || ORGANISMO_TGSS.test(p.proveedor)));
  if (!organismo || (!tipo && !proveedorEsOrganismo)) return undefined;
  const tipoFinal = tipo ?? "notificación";
  return {
    organismo, tipo: tipoFinal,
    razon: `Es una ${tipoFinal} de la ${organismo === "AEAT" ? "Agencia Tributaria" : "Seguridad Social"}${proveedorEsOrganismo ? ` (el emisor es el propio organismo)` : ""}: no es un gasto a crear en Holded; se archiva en la carpeta de requerimientos de su empresa y se revisa e informa.`,
  };
}

/** Pista para el clasificador de carpetas cuando el lector ya vio que es una notificación tributaria. */
export function pistaCarpetaNotificacionTributaria(n: NotificacionTributaria, importe?: string): string {
  return `Leído del contenido: es una NOTIFICACIÓN OFICIAL de la ${n.organismo === "AEAT" ? "Agencia Tributaria (AEAT)" : "Seguridad Social (TGSS)"} (${n.tipo}), ` +
    `NO un gasto ni una factura: va a la carpeta de requerimientos de Hacienda / notificaciones oficiales de su empresa (p. ej. «REQUERIMIENTOS HACIENDA»).` +
    (importe ? ` Importe que figura: ${importe}.` : "") + " No crear gasto en Holded; el operador la revisa y, si procede, se recurre o se paga por su vía.";
}
