import { buscarMensajes, obtenerResumenCorreo, marcarHiloComoLeido } from "../gmail/client";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos, tras notar que Wobi respondió "no tengo una herramienta para marcar
 * correos como leídos" — la función de fondo (marcarHiloComoLeido) ya existía (la usan la cola de
 * revisión, el resumen diario y la conversación automática), pero nunca estuvo expuesta como algo
 * que Claude pudiera usar libremente en una conversación normal — solo la disparaban esos flujos
 * automáticos por su cuenta. Esta tool cierra ese hueco puntual: marcar un correo específico como
 * leído, fuera de esos flujos (ej. "ya lo leí a mano, márcalo").
 */
export const marcarCorreoLeidoTool: ToolDefinition = {
  name: "marcar_correo_leido",
  description:
    "Marca un correo del buzón (asistente@wobagroup.com) como leído en Gmail. Úsala cuando el " +
    "usuario pida explícitamente 'márcalo como leído', 'ya lo leí', 'descarta ese correo de los sin " +
    "leer', o algo similar sobre un correo puntual. No la uses para avanzar la cola normal de " +
    "revisión de correo (esa se resuelve sola con sus propios botones) — es para un correo suelto " +
    "fuera de ese flujo.",
  input_schema: {
    type: "object",
    properties: {
      busqueda: {
        type: "string",
        description:
          "Quién lo mandó y/o de qué trata, para encontrar el correo correcto (ej. 'Alberto', 'la " +
          "factura de Sinfonía'). Si no se da, se usa el más reciente sin leer de la bandeja.",
      },
    },
  },
  handler: async (input) => {
    const busqueda = typeof input.busqueda === "string" ? input.busqueda.trim() : "";
    const query = busqueda ? `${busqueda} in:inbox` : "is:unread in:inbox";

    let ids: string[] = [];
    try {
      ids = await buscarMensajes(query, 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error buscando el correo: ${message}`;
    }

    if (ids.length === 0) {
      return busqueda
        ? `No encontré ningún correo que coincida con "${busqueda}" en la bandeja de entrada.`
        : "No encontré ningún correo sin leer en la bandeja de entrada.";
    }

    const resumen = await obtenerResumenCorreo(ids[0]);
    const ok = await marcarHiloComoLeido(resumen.threadId);

    return ok
      ? `✅ Marcado como leído — "${resumen.asunto}" (de ${resumen.de}).`
      : `Encontré "${resumen.asunto}" (de ${resumen.de}) pero hubo un error de Gmail al marcarlo como leído — intenta de nuevo.`;
  },
};
