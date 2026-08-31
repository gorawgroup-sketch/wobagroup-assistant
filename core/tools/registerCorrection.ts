import { registrarCorreccion } from "../knowledge/correctionsStore";
import type { ToolDefinition } from "./types";

/**
 * Registra una corrección que el usuario hace a algo que el asistente dijo o
 * asumió antes. Se guarda de forma permanente (Sheets, no un archivo local
 * — sobrevive a redeploys) y consultar_base_conocimiento SIEMPRE la incluye
 * en el contexto de cualquier consulta futura, para que el error no se
 * repita.
 */
export const registrarCorreccionTool: ToolDefinition = {
  name: "registrar_correccion",
  description:
    "Registra una corrección que el usuario hace sobre algo que el asistente dijo o asumió antes " +
    "(ej. 'eso no era así, en realidad...', 'corrección: ...', 'no, en realidad es...'). Llama a esta " +
    "herramienta EN CUANTO detectes que el usuario está corrigiendo algo — no esperes a que lo pida " +
    "explícitamente ni le preguntes si quiere que lo registres. " +
    "IMPORTANTE — pedido explícito de Carlos tras un caso real: el mensaje 'considera este tipo de " +
    "gastos como gastos de viaje' (referido a las facturas de moneda extranjera que se estaban " +
    "discutiendo) se guardó por error como una corrección sobre 'Sunreuse' — un concepto de cashflow " +
    "completamente distinto que el asistente adivinó porque el mensaje del usuario no nombraba a qué se " +
    "refería 'este tipo'. Antes de llamar a esta herramienta, el referente (a qué gasto/proveedor/tema " +
    "se refiere la corrección) debe estar CLARO por el propio texto del mensaje actual o del turno " +
    "inmediatamente anterior de la conversación — nunca lo adivines buscando en la base de conocimiento " +
    "ni tomando el último concepto que se te ocurra. Si el usuario usa una referencia ambigua ('esto', " +
    "'este tipo', 'eso') y no es evidente a qué se refiere, PREGUNTA primero qué gasto/proveedor/tema " +
    "específico quiere corregir — no llames a la herramienta con un referente inventado.",
  input_schema: {
    type: "object",
    properties: {
      contexto_previo: {
        type: "string",
        description:
          "Qué había dicho o asumido el sistema antes, que resultó incorrecto (breve, para dar contexto).",
      },
      correccion: {
        type: "string",
        description: "El dato correcto, tal como lo indicó el usuario — esto es lo que debe prevalecer.",
      },
    },
    required: ["correccion"],
  },
  handler: async (input) => {
    const contextoPrevio = typeof input.contexto_previo === "string" ? input.contexto_previo.trim() : "";
    const correccion = typeof input.correccion === "string" ? input.correccion.trim() : "";

    if (!correccion) {
      return "Error: falta el texto de la corrección.";
    }

    await registrarCorreccion({ contextoPrevio, correccion });

    return "Corrección registrada permanentemente. A partir de ahora se incluirá siempre en el contexto de consultar_base_conocimiento.";
  },
};
