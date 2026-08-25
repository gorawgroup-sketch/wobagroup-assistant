import { listarCapturasPendientes } from "../knowledge/capture";
import type { ToolDefinition } from "./types";

/**
 * Muestra qué se ha capturado en docs/_staging que todavía no se ha
 * aprobado ni movido al conocimiento oficial. Solo lectura.
 */
export const revisarCapturasTool: ToolDefinition = {
  name: "revisar_capturas",
  description:
    "Muestra un resumen de todo lo capturado con el prefijo CAPTURA: que aún no se ha aprobado ni " +
    "movido al conocimiento oficial. Úsala cuando el usuario pregunte qué hay pendiente de revisar, " +
    "o pida ver las capturas guardadas.",
  input_schema: { type: "object", properties: {} },
  handler: async () => {
    const archivos = await listarCapturasPendientes();

    if (archivos.length === 0) {
      return "No hay capturas pendientes de aprobar.";
    }

    return archivos.map((a) => `--- ${a.nombre} ---\n${a.contenido}`).join("\n\n");
  },
};
