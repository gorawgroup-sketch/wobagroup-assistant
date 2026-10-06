import { emailValido, registrarEmailTitular, sugerirEmailsDelDirectorio } from "../soportes/titularesSoportesSheet";
import type { ToolDefinition } from "./types";

/**
 * Guarda a qué email se le piden los soportes de un titular de tarjeta. El nombre debe ser el que figura en el extracto
 * («Payer»); el resumen de soportes lo muestra tal cual. Se pide una sola vez por persona y queda para siempre.
 */
export const registrarEmailTitularSoportesTool: ToolDefinition = {
  name: "registrar_email_titular_soportes",
  description:
    "Guarda el email de una persona titular de una tarjeta, para el flujo SEMANAL de pedir soportes. El flujo completo es: " +
    "el usuario pulsa /soportes en el menú (o escribe «pedir soportes»), elige la empresa y sube el CSV de movimientos de Revolut; el " +
    "sistema lo lee solo —NO es un documento para archivar—, cruza cada pago con tarjeta contra Bancos de Holded, detecta los que " +
    "siguen sin soporte conciliado, los agrupa por titular (columna «Payer» del CSV) y muestra un resumen con una casilla por " +
    "persona; al pulsar «Enviar» sale UN correo por persona desde asistente@wobagroup.com pidiendo los soportes a ese mismo buzón. " +
    "Usa esta herramienta cuando el usuario diga a qué correo escribirle a un titular («el correo de Yessenia es …») y luego " +
    "dile que pulse «🔄 Actualizar emails» en el resumen. Si te preguntan cómo se piden soportes a quien gastó con tarjeta, " +
    "explica ese flujo; nunca intentes reconstruirlo a mano con otras herramientas ni propongas correos uno a uno.",
  input_schema: {
    type: "object",
    properties: {
      nombre: { type: "string", description: "Nombre del titular tal como aparece en el resumen o en el extracto (ej. «Yessenia Carolina Dos Prazeres Ferreira»)." },
      email: { type: "string", description: "Dirección de correo a la que se le piden los soportes." },
    },
    required: ["nombre", "email"],
  },
  handler: async (input) => {
    const nombre = typeof input.nombre === "string" ? input.nombre.trim() : "";
    const email = typeof input.email === "string" ? input.email.trim() : "";
    if (!nombre) return "Error: falta el nombre del titular.";
    if (!emailValido(email)) {
      const sugeridos = await sugerirEmailsDelDirectorio(nombre);
      return `Error: «${email}» no es una dirección de correo válida.${sugeridos.length ? ` En el directorio hay: ${sugeridos.join("; ")}.` : ""}`;
    }
    if (!(await registrarEmailTitular(nombre, email))) return "Error: no se pudo guardar el email.";
    return `Guardado: los soportes de ${nombre} se piden a ${email.toLowerCase()}. Dile al usuario que pulse «🔄 Actualizar emails» en el resumen de soportes para verlo reflejado.`;
  },
};
