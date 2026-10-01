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
    "confirma que lo encontró y lo mandó. Si el correo venía reenviado, también dice quién fue el " +
    "remitente ORIGINAL dentro de la cadena (nombre y email reales, no quien hizo el reenvío) — úsalo, " +
    "por ejemplo, para responderle directo a esa persona sin tener que volver a pedirle el dato al " +
    "usuario. Nunca uses esto para la revisión normal de correo (eso ya " +
    "pasa solo, por cron, o con /revisarcorreo) — solo cuando el usuario pida explícitamente saltar a " +
    "un correo puntual, incluso si ya está leído. Con solo_archivar=true es el canal de DOCUMENTOS (no el de gastos): " +
    "úsalo cuando el usuario pida guardar o archivar en Drive los adjuntos de un correo, o diga que un adjunto no es " +
    "un gasto sino un documento (pólizas, contratos, normativa, compliance…) — cada adjunto aún no archivado recibe su " +
    "propuesta de carpeta con botones, también si antes se propuso como gasto y se canceló, y también si es el correo " +
    "activo de la cola. Los documentos de seguros, al archivarse, los lee Wobi Seguros automáticamente.",
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
      solo_archivar: {
        type: "boolean",
        description:
          "true cuando el usuario quiere GUARDAR los adjuntos de ese correo como documentos en Drive (no procesarlos " +
          "como gastos). Sin esto, el correo recibe el tratamiento normal.",
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

    const soloArchivar = input.solo_archivar === true || input.solo_archivar === "true";
    const resultado = await procesarCorreoPuntual(chatId, busqueda, { soloArchivar });

    if (!resultado.encontrado) {
      return `No encontré ningún correo que coincida con la referencia concreta "${busqueda}" en la bandeja de entrada, ni leído ni sin leer.`;
    }

    // Hallazgo real de auditoría (Carlos, caso real Simon Talloen / Go Rent A Car, 2026-09-30): "de"
    // es quien reenvió el correo al buzón del asistente (casi siempre alguien del grupo, nunca el
    // remitente original de un correo reenviado) — si el cuerpo SÍ traía una cadena de reenvío con un
    // remitente original distinto, se lo decimos explícitamente al modelo (nombre + email reales,
    // nunca inventados) para que pueda responderle directo sin tener que volver a preguntar un dato
    // que el propio correo ya daba. Hallazgo de la revisión adversarial: esto es texto plano dentro
    // de un correo, que puede venir de fuera del grupo — nunca "el email verificado de X", solo lo
    // que el propio cuerpo del correo afirma; quien apruebe el envío sigue viendo el destinatario
    // real antes de mandar nada (proponer_envio_correo nunca envía sin esa confirmación explícita).
    const notaRemitenteOriginal = resultado.remitenteOriginal
      ? ` El cuerpo trae una cadena de reenvío que indica como remitente original a ${
          resultado.remitenteOriginal.nombre ? `${resultado.remitenteOriginal.nombre} ` : ""
        }<${resultado.remitenteOriginal.email}> — tal como lo escribió el correo, sin verificar aparte; confírmalo con el destinatario real antes de enviar nada.`
      : "";

    if (soloArchivar) {
      if (resultado.sinAdjuntos) {
        return `Encontré "${resultado.asunto}" (de ${resultado.de}), pero no trae adjuntos que guardar en Drive.`;
      }
      return (
        `Encontré "${resultado.asunto}" (de ${resultado.de}) y mandé a archivar sus ${resultado.adjuntos ?? ""} adjunto(s) como ` +
        "documentos: cada uno que no estuviera ya archivado tiene arriba en el chat su propuesta de carpeta con el botón " +
        "«✅ Sí, archivar aquí» (o «✏️ Elegir otra carpeta»). No se propuso ningún gasto. Los que van a la carpeta de " +
        "seguros los leerá Wobi Seguros al archivarse." + notaRemitenteOriginal
      );
    }

    if (resultado.yaEsElActivo) {
      return (
        `"${resultado.asunto}" (de ${resultado.de}) es justo el correo activo de la cola de revisión ahora mismo — ` +
        "ya tiene su propia propuesta con botones arriba en el chat, resuélvela desde ahí en vez de duplicarla." +
        notaRemitenteOriginal
      );
    }

    return (
      `Encontré y procesé "${resultado.asunto}" (de ${resultado.de}) — ya te mandé la propuesta con botones arriba en el chat.` +
      notaRemitenteOriginal
    );
  },
};
