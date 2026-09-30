/**
 * La conversación en curso manda sobre un pendiente antiguo.
 *
 * Caso real (Carlos, 2026-09-30): llevaba varios mensajes hablando de una factura de Telefónica y escribió «verifica
 * si el gasto ya está creado y conciliado y esto es un duplicado». El prompt recordaba además una pregunta SIN
 * RESPONDER de otro gasto (Anthropic, 24,20 USD) que pedía «verificar duplicados»; la frase encajaba con ese texto y
 * el modelo contestó sobre Anthropic. Un pendiente se recuerda en CADA turno, hable de lo que hable el usuario, así
 * que sin una señal de tema gana el pendiente aunque la conversación vaya por otro lado.
 *
 * Aquí se decide de forma determinista si el pendiente está «en tema» (lo nombra el mensaje actual o los últimos
 * turnos) y, si no lo está, se añade una instrucción explícita de continuidad. No decide qué hacer: solo le dice al
 * modelo de qué se viene hablando.
 */
const RELLENO = new Set([
  "para", "pero", "como", "esto", "esta", "este", "estos", "estas", "desde", "sobre", "entre", "cuando", "donde",
  "gasto", "gastos", "factura", "facturas", "empresa", "empresas", "group", "grupo", "limited", "unlimited", "company",
  "sociedad", "services", "servicios", "international", "ireland", "spain", "espana",
]);

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Palabras que identifican al proveedor (4+ letras, sin formas societarias ni relleno). */
export function palabrasIdentidadProveedor(proveedor: string): string[] {
  return [...new Set(normalizar(proveedor).split(/[^a-z0-9]+/).filter((p) => p.length >= 4 && !RELLENO.has(p)))];
}

function importeEnTexto(texto: string, monto: number): boolean {
  if (!Number.isFinite(monto) || monto <= 0) return false;
  const [entero, decimales] = monto.toFixed(2).split(".");
  const variantes = [`${entero},${decimales}`, `${entero}.${decimales}`];
  if (decimales.endsWith("0")) variantes.push(`${entero},${decimales[0]}`, `${entero}.${decimales[0]}`);
  // Límite de cifra: «24,20» no debe encontrarse dentro de «124,20» ni de «24,205».
  return variantes.some((v) => new RegExp(`(^|[^0-9])${v.replace(".", "\\.")}(?![0-9])`).test(texto));
}

export function textoMencionaPendiente(texto: string, pendiente: { proveedor: string; monto?: number }): boolean {
  const normal = normalizar(texto);
  if (palabrasIdentidadProveedor(pendiente.proveedor).some((p) => new RegExp(`(^|[^a-z0-9])${p}`).test(normal))) return true;
  return pendiente.monto !== undefined && importeEnTexto(texto, pendiente.monto);
}

export interface ContextoConversacion {
  mensajeActual: string;
  /** Texto de los últimos turnos (usuario y asistente), del más antiguo al más reciente. */
  turnosRecientes: string[];
}

/**
 * Devuelve la instrucción de continuidad cuando la conversación reciente NO trata del pendiente; "" si el pendiente
 * está en tema, si no hay conversación previa, o si el mensaje actual lo nombra.
 */
export function notaContinuidadConversacion(
  pendiente: { proveedor: string; monto?: number },
  conversacion: ContextoConversacion | undefined
): string {
  if (!conversacion) return "";
  if (textoMencionaPendiente(conversacion.mensajeActual, pendiente)) return "";
  const recientes = conversacion.turnosRecientes.filter((t) => t.trim());
  if (recientes.length === 0) return "";
  if (recientes.some((t) => textoMencionaPendiente(t, pendiente))) return "";
  return (
    ` ATENCIÓN — CONVERSACIÓN EN CURSO: los últimos mensajes de este chat tratan de OTRO asunto y no mencionan ` +
    `"${pendiente.proveedor}". El mensaje actual es la continuación de ESA conversación: refiérete al mismo documento, ` +
    `proveedor e importe del que se venía hablando en los turnos anteriores, NO a este pendiente, aunque sus palabras ` +
    `("duplicado", "conciliado", "verifica"…) se parezcan a esta pregunta. No uses las herramientas de este pendiente ` +
    `ni lo menciones salvo que el usuario nombre expresamente "${pendiente.proveedor}" o su importe. Si tras releer ` +
    `los últimos turnos no queda claro a cuál de los dos se refiere, pregúntaselo en una sola línea nombrando ambos.`
  );
}

/** Texto plano de un mensaje del historial (ignora bloques de herramienta). */
export function textoDeMensajeHistorial(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}
