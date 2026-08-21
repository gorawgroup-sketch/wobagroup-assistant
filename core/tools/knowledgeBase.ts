import { loadKnowledgeBase } from "../knowledge/loader";
import type { ToolDefinition } from "./types";

/**
 * Primera herramienta del asistente: da acceso al documento de responsabilidades
 * del grupo (WOBA/BAE, Footprint, eWorks) bajo demanda, en vez de inyectarlo
 * siempre como contexto fijo del sistema.
 */
export const knowledgeBaseTool: ToolDefinition = {
  name: "consultar_base_conocimiento",
  description:
    "Consulta el documento de responsabilidades internas del grupo (WOBA/BAE, Footprint, eWorks). " +
    "Úsala cuando el usuario pregunte sobre procesos administrativos, responsabilidades de cada " +
    "empresa, domiciliaciones, recomendaciones operativas, o cualquier tema que dependa de ese " +
    "documento. No la uses para saludos, small talk, o preguntas que no requieran ese contexto.",
  input_schema: {
    type: "object",
    properties: {
      consulta: {
        type: "string",
        description:
          "Tema o pregunta específica que motiva la consulta (por ejemplo: 'domiciliaciones de BAE', " +
          "'onboarding de un colaborador nuevo en Footprint').",
      },
    },
    required: ["consulta"],
  },
  handler: async () => {
    const knowledge = loadKnowledgeBase();
    return knowledge || "No se ha cargado ningún documento de responsabilidades todavía.";
  },
};
