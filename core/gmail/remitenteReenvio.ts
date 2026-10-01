import { extraerDireccionCorreo } from "./client";

/**
 * Extrae el nombre y el email ORIGINAL de una cadena de reenvío de Gmail — el "From:"/"De:" que
 * aparece justo después del separador "---------- Forwarded message ---------" (o su variante en
 * español, "---------- Mensaje reenviado ---------"), nunca el remitente del último reenvío: para un
 * correo reenviado al buzón del asistente, el header real del mensaje (CorreoResumen.de) es casi
 * siempre la persona del grupo que lo reenvió, no quien originó el asunto real. Mismo criterio ya
 * usado en los prompts de extracción de factura/gasto (ver extractInvoiceData.ts,
 * extraerGastoDeCorreo.ts) — acá se hace reutilizable para cualquier otro propósito que necesite el
 * EMAIL real, no solo un nombre para tag.
 *
 * Hallazgo real de auditoría (Carlos, caso real Simon Talloen / Go Rent A Car, 2026-09-30): el
 * sistema ya sabía extraer el nombre del remitente original para usarlo como tag, pero nunca el email
 * — así que no podía responderle directamente a esa persona aunque su dirección ya estuviera, letra
 * por letra, en el propio correo que acababa de procesar.
 */
export interface RemitenteOriginalReenvio {
  nombre?: string;
  email: string;
}

const SEPARADOR_REENVIO = /^-{2,}\s*(forwarded message|mensaje reenviado)\s*-{2,}\s*$/im;
const LINEA_FROM = /^(?:From|De)\s*:\s*(.+)$/im;
// Forma real de un email — no solo "contiene una @" (hallazgo real de la revisión adversarial: un
// "From:" malformado o con un ángulo sin cerrar podía dejar pasar basura tipo "3 talloen <x@y.com"
// o "nombre (x@y.com)" como si fuera una dirección válida).
const EMAIL_VALIDO = /^[^\s<>()@]+@[^\s<>()@]+\.[^\s<>()@]+$/;

export function extraerRemitenteOriginalDeReenvio(cuerpo: string): RemitenteOriginalReenvio | undefined {
  const separador = SEPARADOR_REENVIO.exec(cuerpo);
  if (!separador) return undefined;

  const resto = cuerpo.slice(separador.index + separador[0].length);
  const from = LINEA_FROM.exec(resto);
  if (!from) return undefined;

  const valor = from[1].trim();
  const email = extraerDireccionCorreo(valor);
  if (!EMAIL_VALIDO.test(email)) return undefined;

  // Solo hay nombre real si el valor traía "Nombre <email>" — un email suelto, sin "<...>", no tiene
  // nombre visible que extraer (si no, el email entero quedaría duplicado como "nombre").
  const tieneAngulos = /<[^>]*>/.test(valor);
  const nombreCrudo = tieneAngulos ? valor.replace(/<[^>]*>/, "").trim().replace(/^"|"$/g, "").trim() : "";
  // Hallazgo real de la revisión adversarial: un "From:" tipo `"otro@falso.com" <real@verdadero.com>`
  // protegía bien el email (extraerDireccionCorreo nunca se deja engañar por el texto visible), pero
  // el "nombre" quedaba siendo literalmente esa otra dirección falsa — un "nombre" que a su vez
  // contiene "@" nunca es un nombre humano real, se descarta en vez de mostrarlo como si lo fuera.
  const nombre = nombreCrudo && !nombreCrudo.includes("@") ? nombreCrudo : undefined;
  return { nombre, email };
}
