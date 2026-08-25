import { aprobarYMoverCapturas, listarCapturasPendientes } from "../knowledge/capture";
import { invalidarCacheConocimiento } from "../knowledge/loader";
import type { ToolDefinition } from "./types";

/**
 * Mueve el contenido de docs/_staging al archivo de conocimiento oficial
 * indicado (se crea si no existe) y borra los borradores ya incorporados.
 * Solo toca archivos .md locales dentro de /docs — no hay riesgo financiero
 * ni de sistemas externos, por eso (a diferencia de cashflow/Drive) sí está
 * registrado como tool normal que Claude puede invocar en conversación.
 */
export const aprobarCapturasTool: ToolDefinition = {
  name: "aprobar_capturas",
  description:
    "Mueve TODAS las capturas pendientes (docs/_staging) al archivo de conocimiento oficial indicado, " +
    "y borra los borradores ya incorporados. Antes de llamarla, si no es obvio a qué archivo deberían " +
    "ir (usa revisar_capturas para ver el contenido si hace falta), pregúntale al usuario a cuál " +
    "archivo van en vez de adivinar.",
  input_schema: {
    type: "object",
    properties: {
      archivo_destino: {
        type: "string",
        description:
          "Nombre del archivo .md dentro de /docs donde se incorpora el contenido (ej. " +
          "'onboarding_offboarding.md'). Si no existe, se crea.",
      },
    },
    required: ["archivo_destino"],
  },
  handler: async (input) => {
    const archivoDestino = typeof input.archivo_destino === "string" ? input.archivo_destino.trim() : "";
    if (!archivoDestino) {
      return "Error: falta 'archivo_destino'.";
    }

    const pendientes = await listarCapturasPendientes();
    if (pendientes.length === 0) {
      return "No hay capturas pendientes para aprobar.";
    }

    const resultado = await aprobarYMoverCapturas(archivoDestino);
    invalidarCacheConocimiento();

    return (
      `Se movieron ${resultado.movidas} captura(s) a ${resultado.destino}. ` +
      `El conocimiento oficial ya está actualizado (consultar_base_conocimiento lo reflejará de inmediato).`
    );
  },
};
