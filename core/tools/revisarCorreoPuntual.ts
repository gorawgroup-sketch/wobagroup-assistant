import { procesarCorreoPuntual } from "../jobs/revisarCorreoNuevo";
import { esReferenciaCorreoConcreta } from "../gmail/referenciaCorreo";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos: poder decirle "vamos al correo de X, léelo,
 * reprocesa o respondamos" en vez de esperar a que le toque el turno en la cola de
 * revisión (más antiguo a más nuevo, un correo a la vez con "▶️ Sí,
 * siguiente"). Esta tool es un camino PARALELO y SEPARADO — ver
 * procesarCorreoPuntual en revisarCorreoNuevo.ts (deColaCorreo=false) —
 * nunca toca ni confunde la cola: si hay un correo activo de la cola
 * esperando resolución en este momento, sigue exactamente donde estaba
 * después de usar esta herramienta.
 */
export const revisarCorreoPuntualTool: ToolDefinition = {
  name: "revisar_correo_puntual",
  description:
    "Busca y procesa AHORA MISMO un correo específico del buzón (asistente@wobagroup.com), fuera de " +
    "la cola normal de revisión (que va de más antiguo a más nuevo, uno a la vez) — úsala cuando el " +
    "usuario pida ir directo a un correo puntual identificado ('vamos al correo de X', 'lee el correo de " +
    "tal persona/tema y respondamos', 'revisa ya el mail sobre Y'), en vez de esperar el turno de la " +
    "cola. Como exige una referencia CONCRETA, puede encontrar también un correo ya leído del historial para " +
    "reprocesarlo, extraer información o preparar una respuesta. Encuentra el correo más reciente que coincida " +
    "con la búsqueda y le da el MISMO tratamiento " +
    "que a cualquier otro correo (si tiene adjuntos, los clasifica como documento/gasto; si describe un " +
    "gasto en el cuerpo, propone crearlo; si no, genera una propuesta con resumen + acción sugerida y " +
    "botones) — la propuesta resultante ya trae sus propios botones en el chat, esta herramienta solo " +
    "confirma que lo encontró y lo mandó. Nunca uses esto para la revisión normal de correo (eso ya " +
    "pasa solo, por cron, o con /revisarcorreo) — solo cuando el usuario pida explícitamente saltar a " +
    "un correo puntual, incluso si ya está leído.",
  input_schema: {
    type: "object",
    properties: {
      busqueda: {
        type: "string",
        description:
          "Quién lo mandó y/o de qué trata, para encontrar el correo correcto (ej. 'Alberto', " +
          "'Alberto Comolli', 'la factura de Sinfonía', 'proveedor@dominio.com') — puede ser lenguaje " +
          "natural o una consulta real de Gmail (ej. 'from:alberto@wobagroup.com').",
      },
    },
    required: ["busqueda"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) {
      return "Error: no se pudo determinar el chat de Telegram para mandar la propuesta de este correo.";
    }

    const busqueda = typeof input.busqueda === "string" ? input.busqueda.trim() : "";
    if (!busqueda) return "Error: falta 'busqueda' (a quién o a qué corresponde el correo).";
    if (!esReferenciaCorreoConcreta(busqueda)) {
      return "La referencia es demasiado general para buscar también entre correos leídos. Usa revisar_cola_correo para procesar solo los no leídos, del más antiguo al más nuevo.";
    }

    const resultado = await procesarCorreoPuntual(chatId, busqueda);

    if (!resultado.encontrado) {
      return `No encontré ningún correo que coincida con la referencia concreta "${busqueda}" en la bandeja de entrada, ni leído ni sin leer.`;
    }

    if (resultado.yaEsElActivo) {
      return (
        `"${resultado.asunto}" (de ${resultado.de}) es justo el correo activo de la cola de revisión ahora mismo — ` +
        "ya tiene su propia propuesta con botones arriba en el chat, resuélvela desde ahí en vez de duplicarla."
      );
    }

    return `Encontré y procesé "${resultado.asunto}" (de ${resultado.de}) — ya te mandé la propuesta con botones arriba en el chat.`;
  },
};
