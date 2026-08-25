import { buscarDocumentosRelevantes, obtenerIndiceDocumentos } from "../knowledge/loader";
import { obtenerCorreccionesFormateadas } from "../knowledge/correctionsStore";
import type { ToolDefinition } from "./types";

/**
 * Da acceso al conocimiento interno del grupo (WOBA/BAE, Footprint, eWorks):
 * selecciona solo los documentos de /docs relevantes a la consulta (en vez
 * de concatenar todo el contenido en cada llamada) y SIEMPRE incluye las
 * correcciones registradas (registrar_correccion), sin importar la
 * consulta — un dato ya corregido una vez nunca debe volver a olvidarse.
 */
export const knowledgeBaseTool: ToolDefinition = {
  name: "consultar_base_conocimiento",
  description:
    "Consulta el conocimiento interno del grupo (WOBA/BAE, Footprint, eWorks): responsabilidades, " +
    "procesos administrativos, domiciliaciones, recomendaciones operativas, contactos, y cualquier " +
    "corrección que se haya hecho antes sobre algo que el asistente asumió mal. Úsala cuando la " +
    "pregunta dependa de ese contexto. No la uses para saludos o small talk.",
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
  handler: async (input) => {
    const consulta = typeof input.consulta === "string" ? input.consulta : "";
    const partes: string[] = [];

    const correcciones = await obtenerCorreccionesFormateadas();
    if (correcciones) {
      partes.push(
        `## ⚠️ Correcciones registradas — SIEMPRE prioritarias sobre cualquier otro documento o suposición\n\n${correcciones}`
      );
    }

    const relevantes = buscarDocumentosRelevantes(consulta);

    if (relevantes.length > 0) {
      partes.push(relevantes.map((d) => `<!-- Fuente: docs/${d.nombre} -->\n${d.contenido}`).join("\n\n---\n\n"));
    } else {
      const indice = obtenerIndiceDocumentos();
      if (indice.length > 0) {
        partes.push(
          "No encontré documentos claramente relevantes a esa consulta por palabras clave. Documentos " +
            "disponibles (vuelve a consultar mencionando el tema con más detalle si alguno aplica):\n" +
            indice.map((d) => `- ${d.nombre}: ${d.resumen}`).join("\n")
        );
      }
    }

    return partes.length > 0 ? partes.join("\n\n===\n\n") : "No hay ningún documento cargado en la base de conocimiento todavía.";
  },
};
