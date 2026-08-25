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
    "explícitamente ni le preguntes si quiere que lo registres. Queda guardada permanentemente y se " +
    "incluye siempre en el contexto de consultar_base_conocimiento a partir de ese momento.",
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
