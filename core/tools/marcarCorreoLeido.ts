import { buscarMensajes, obtenerResumenCorreo, marcarHiloComoLeido } from "../gmail/client";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos, tras notar que Wobi respondió "no tengo una herramienta para marcar
 * correos como leídos" — la función de fondo (marcarHiloComoLeido) ya existía (la usan la cola de
 * revisión, el resumen diario y la conversación automática), pero nunca estuvo expuesta como algo
 * que Claude pudiera usar libremente en una conversación normal — solo la disparaban esos flujos
 * automáticos por su cuenta. Esta tool cierra ese hueco puntual: marcar un correo específico como
 * leído, fuera de esos flujos (ej. "ya lo leí a mano, márcalo").
 *
 * `busqueda` es OBLIGATORIA a propósito — hallazgo real al probar en vivo: la primera versión la
 * dejaba opcional (sin ella, tomaba "el más reciente sin leer"), y esa única llamada de prueba
 * terminó marcando como leído un correo real de un proveedor que Carlos no había visto todavía. Sin
 * un término que identifique el correo, esta tool nunca debe adivinar cuál — mismo criterio que el
 * resto del proyecto (nunca asumir sin evidencia clara).
 */
export const marcarCorreoLeidoTool: ToolDefinition = {
  name: "marcar_correo_leido",
  description:
    "Marca un correo del buzón (asistente@wobagroup.com) como leído en Gmail. Úsala cuando el " +
    "usuario pida explícitamente 'márcalo como leído', 'ya lo leí', 'descarta ese correo de los sin " +
    "leer', o algo similar sobre un correo puntual QUE SE PUEDA IDENTIFICAR (remitente, asunto o " +
    "tema). Si no sabes a cuál correo se refiere, pregúntale antes de llamar esta herramienta — nunca " +
    "adivines 'el más reciente' ni la llames sin 'busqueda', podrías marcar como leído un correo real " +
    "que el usuario todavía no vio. No la uses para avanzar la cola normal de revisión de correo (esa " +
    "se resuelve sola con sus propios botones) — es para un correo suelto fuera de ese flujo.",
  input_schema: {
    type: "object",
    properties: {
      busqueda: {
        type: "string",
        description:
          "Quién lo mandó y/o de qué trata, para encontrar el correo correcto (ej. 'Alberto', 'la " +
          "factura de Sinfonía'). Obligatorio — nunca se adivina el correo.",
      },
    },
    required: ["busqueda"],
  },
  handler: async (input) => {
    const busqueda = typeof input.busqueda === "string" ? input.busqueda.trim() : "";
    if (!busqueda) return "Error: falta 'busqueda' — nunca se adivina a cuál correo te refieres, dime quién lo mandó o de qué trata.";

    let ids: string[] = [];
    try {
      ids = await buscarMensajes(`${busqueda} in:inbox`, 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error buscando el correo: ${message}`;
    }

    if (ids.length === 0) {
      return `No encontré ningún correo que coincida con "${busqueda}" en la bandeja de entrada.`;
    }

    const resumen = await obtenerResumenCorreo(ids[0]);
    const ok = await marcarHiloComoLeido(resumen.threadId);

    return ok
      ? `✅ Marcado como leído — "${resumen.asunto}" (de ${resumen.de}).`
      : `Encontré "${resumen.asunto}" (de ${resumen.de}) pero hubo un error de Gmail al marcarlo como leído — intenta de nuevo.`;
  },
};
