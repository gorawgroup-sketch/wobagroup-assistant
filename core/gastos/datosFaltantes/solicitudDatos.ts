import type { GastoPendienteDatos } from "../gastoPendienteDatosStore";

/**
 * Pedir al CREADOR del gasto lo que falta para registrarlo y conciliarlo (Carlos, 2026-10-14): cuando un comprobante recibido por correo no trae un dato
 * imprescindible (fecha, moneda, comercio o empresa), no basta con avisar a Carlos: se le escribe a quien envió el comprobante, de forma profesional,
 * con lo mínimo que hay que preguntar. Lógica pura: agrupa los gastos pendientes por persona y redacta el detalle de cada una; el envío es el correo a
 * una audiencia de core/comunicaciones/ (resumen con botón y aprobación de un superadministrador).
 */
export const ASUNTO_SOLICITUD_DATOS = "Información necesaria para registrar tus gastos";

export const CUERPO_SOLICITUD_DATOS = [
  "Hola, {nombre}:",
  "",
  "Gracias por enviarnos los comprobantes de tus gastos. Para poder registrarlos y conciliarlos correctamente en nuestra contabilidad necesitamos que nos confirmes lo siguiente:",
  "",
  "{detalle}",
  "",
  "Por favor, responde a este correo con la información (o adjunta el documento donde se vea). En cuanto la recibamos, registramos y conciliamos el gasto.",
  "",
  "Gracias por tu colaboración.",
].join("\n");

/** Motivos por los que se puede pedir el dato al creador. `verificacion_duplicado` es una duda interna de Wobi: no se le pregunta a nadie. */
export type MotivoPreguntable = "fecha" | "moneda" | "proveedor" | "empresa";
export const esMotivoPreguntable = (m: string): m is MotivoPreguntable => m === "fecha" || m === "moneda" || m === "proveedor" || m === "empresa";

const PREGUNTA: Record<MotivoPreguntable, string> = {
  fecha: "no se distingue la fecha en el comprobante. ¿Puedes indicarnos la fecha en que se realizó el gasto (día, mes y año)?",
  moneda: "no queda claro en qué moneda se pagó. ¿Puedes confirmarnos la moneda y el importe exacto que se cargó a tu tarjeta?",
  proveedor: "no logramos identificar con certeza el establecimiento. ¿Cuál es el nombre del comercio tal como aparece en tu extracto?",
  empresa: "¿A qué empresa del grupo (WOBA, EWORKS o Footprint) corresponde este gasto?",
};

/** Texto limpio de un nombre leído de un comprobante: sin entidades HTML y sin la apostilla interna «(nombre probable, …)». */
export function limpiarNombre(texto: string): string {
  return texto
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/g, "'")
    .replace(/\s*\([^)]*(probable|no legible|ilegible)[^)]*\)/gi, "")
    .replace(/\s+/g, " ").trim();
}

const importe = (n: number): string => new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(n);

/** Extrae la dirección y el nombre del encabezado «"Nombre" <correo@dominio>». */
export function parsearRemitente(de: string): { nombre: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(de);
  if (m) return { nombre: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { nombre: "", email: de.trim().toLowerCase() };
}

export interface SolicitudCreador { nombre: string; email: string; detalle: string; pendientes: string[] }

/**
 * Agrupa los pendientes de datos por creador (el remitente del correo) y redacta una línea por gasto. El mismo comprobante reenviado dos veces
 * (mismo comercio, importe, moneda y motivo) cuenta una sola vez. `excluirEmails`: direcciones a las que nunca se escribe (el buzón de Wobi, los propios
 * superadministradores).
 */
export function agruparSolicitudes(pendientes: readonly GastoPendienteDatos[], excluirEmails: readonly string[] = []): SolicitudCreador[] {
  const excluidos = new Set(excluirEmails.map((e) => e.toLowerCase()));
  const porCreador = new Map<string, { nombre: string; lineas: Map<string, string>; ids: string[] }>();
  for (const p of pendientes) {
    if (!p.deColaCorreo || !p.correoOrigen?.de || !esMotivoPreguntable(p.motivo)) continue;
    const { nombre, email } = parsearRemitente(p.correoOrigen.de);
    if (!email || !email.includes("@") || excluidos.has(email)) continue;
    const proveedor = limpiarNombre(p.datos.proveedor) || "comercio sin identificar";
    const asunto = limpiarNombre((p.correoOrigen.asunto ?? "").replace(/^(re|fwd?|rv):\s*/gi, ""));
    const clave = `${proveedor.toLowerCase()}|${p.datos.monto}|${p.datos.moneda}|${p.motivo}`;
    const linea = `• ${proveedor} · ${importe(p.datos.monto)} ${p.datos.moneda}${asunto ? ` (correo «${asunto}»)` : ""}: ${PREGUNTA[p.motivo]}`;
    const g = porCreador.get(email) ?? { nombre, lineas: new Map<string, string>(), ids: [] };
    if (!g.nombre && nombre) g.nombre = nombre;
    if (!g.lineas.has(clave)) g.lineas.set(clave, linea);
    g.ids.push(p.id);
    porCreador.set(email, g);
  }
  return [...porCreador.entries()].map(([email, g]) => ({ nombre: g.nombre || email.split("@")[0], email, detalle: [...g.lineas.values()].join("\n"), pendientes: g.ids }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}
