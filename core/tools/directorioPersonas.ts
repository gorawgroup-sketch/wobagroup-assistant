import { buscarPersonas } from "../directorio/directorioPersonasSheet";
import type { ToolDefinition } from "./types";

/**
 * Directorio de personas que el sistema reconoce solo, sin que nadie lo
 * cargue a mano — se alimenta de quién se autoriza por Telegram y con quién
 * se cruza correo (entrante y saliente). Úsala para resolver un nombre a un
 * email real antes de proponer un correo, o para reconocer a alguien que
 * solo se menciona por su nombre de pila.
 */
export const directorioPersonasTool: ToolDefinition = {
  name: "consultar_directorio_personas",
  seguraParaModoRapido: true,
  description:
    "Busca en el directorio de personas que el sistema ha ido reconociendo (por autorización en " +
    "Telegram o por correos cruzados) para encontrar el email real y el contexto de alguien mencionado " +
    "solo por su nombre (ej. 'Pep', 'Alejandra'). Úsala ANTES de proponer un correo a alguien si no " +
    "tienes su email exacto en el mensaje del usuario ni en la conversación — nunca inventes ni adivines " +
    "un email.",
  input_schema: {
    type: "object",
    properties: {
      nombre: { type: "string", description: "Nombre (o parte del nombre/email) de la persona a buscar." },
    },
    required: ["nombre"],
  },
  handler: async (input) => {
    const nombre = typeof input.nombre === "string" ? input.nombre.trim() : "";
    if (!nombre) return "Error: falta 'nombre' para buscar en el directorio.";

    const resultados = await buscarPersonas(nombre);
    if (resultados.length === 0) {
      return `No encontré a nadie en el directorio que coincida con "${nombre}" — nunca inventes un email, pregúntale a la persona.`;
    }

    return resultados
      .map((p) => `${p.nombre || "(sin nombre)"} — ${p.email || "(sin email conocido)"} — visto por ${p.origen}, ${p.vecesVisto} vez/veces, última vez ${p.ultimaVez.slice(0, 10)}`)
      .join("\n");
  },
};
