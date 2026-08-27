import { seleccionarDocumentosRelevantes, obtenerIndiceDocumentos } from "../knowledge/loader";
import { obtenerCorreccionesFormateadas } from "../knowledge/correctionsStore";
import { obtenerCapturasFormateadas } from "../knowledge/capturaSheet";
import type { ToolDefinition } from "./types";

/**
 * Da acceso al conocimiento interno del grupo (WOBA/BAE, Footprint, eWorks):
 * carga los documentos de /docs vía seleccionarDocumentosRelevantes — todos,
 * completos, mientras el corpus quepa bajo UMBRAL_CARGA_COMPLETA (ver
 * loader.ts); solo aplica scoring por palabras clave cuando el volumen ya no
 * cabe. SIEMPRE incluye además las correcciones y las capturas registradas
 * (registrar_correccion, mensajes con CAPTURA), sin importar la consulta ni
 * el umbral — un dato ya corregido o capturado una vez nunca debe volver a
 * olvidarse. Las capturas dejaron de vivir como archivo en /docs
 * (docs/conocimiento_capturado.md, retirado el 2026-08-26 porque no
 * sobrevivía un redeploy de Railway) precisamente para que queden aquí,
 * siempre presentes, en vez de competir por espacio con los documentos
 * regulares.
 */
export const knowledgeBaseTool: ToolDefinition = {
  name: "consultar_base_conocimiento",
  description:
    "Consulta el conocimiento interno del grupo (WOBA/BAE, Footprint, eWorks): responsabilidades, " +
    "procesos administrativos, domiciliaciones, recomendaciones operativas, contactos, credenciales de " +
    "plataformas, y el CALENDARIO DE PAGOS RECURRENTES capturado por el equipo (cuándo se cobra cada " +
    "suscripción/servicio, con qué tarjeta, quién recibe la factura, cómo descargarla) — y cualquier " +
    "corrección que se haya hecho antes sobre algo que el asistente asumió mal. Para preguntas del tipo " +
    "'cuándo/cómo se paga X', 'con qué tarjeta está domiciliado X', o cualquier dato que alguien haya " +
    "capturado antes con CAPTURA, consulta esta herramienta SIEMPRE primero — es la fuente autoritativa, " +
    "más confiable que inferir del historial de movimientos de Holded (que solo confirma cargos ya " +
    "ocurridos, no el calendario ni las instrucciones de pago). No la uses para saludos o small talk.",
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

    const capturas = await obtenerCapturasFormateadas();
    if (capturas) {
      partes.push(`## 📌 Conocimiento capturado por el equipo (CAPTURA)\n\n${capturas}`);
    }

    const relevantes = seleccionarDocumentosRelevantes(consulta);

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
