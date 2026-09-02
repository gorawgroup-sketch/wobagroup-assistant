import { sendTelegramMessageWithButtons } from "../telegram/client";
import { programarAccion } from "../jobs/accionesProgramadasStore";
import type { ToolDefinition } from "./types";

const FECHA_HORA_RE = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/;

/**
 * Pedido explícito de Carlos: "tú deberías hacerlas... me va pidiendo
 * autorización para hacerlas o programar cuando las haces, pero no las
 * dejé para que yo las haga — WOBI debe encargarse de las acciones que
 * haya que hacer". Cuando lo que se pide está condicionado a una fecha
 * futura ("hazlo el jueves") o a que algo pase antes ("cuando confirmen el
 * pago de X"), esta herramienta reemplaza intentarlo ahora — guarda la
 * acción (ver accionesProgramadasStore.ts, Sheets, no memoria efímera) y
 * revisarAccionesProgramadas.ts la dispara sola en su momento, sin volver a
 * pedir aprobación (la aprobación ya la dio quien pidió programar esto).
 * Cuando la acción se dispare y de verdad requiera una escritura real
 * (Holded, correo), esa escritura sigue pasando por SU propio flujo normal
 * de propuesta+botón — esta herramienta no le da a Claude ningún poder
 * nuevo, solo pospone CUÁNDO investiga y propone.
 */
export const programarAccionFuturaTool: ToolDefinition = {
  name: "programar_accion_futura",
  description:
    "Programa una acción para ejecutarla más adelante, en vez de intentarla ahora — úsala cuando el usuario " +
    "pida algo condicionado a una fecha futura ('hazlo el jueves', 'la semana que viene', 'avísame el 15') o a " +
    "que algo pase antes ('cuando confirmen el pago de X', 'cuando llegue la factura de Y'). NUNCA la ejecutes " +
    "de inmediato con una aproximación — llama a esta herramienta para guardarla; el sistema la revisará solo " +
    "y la ejecutará (o verificará la condición) en su momento, avisando por Telegram con el resultado. Si lo " +
    "que piden es para AHORA, no uses esta herramienta — actúa directo con tus otras herramientas.",
  input_schema: {
    type: "object",
    properties: {
      tipo: {
        type: "string",
        enum: ["fecha", "condicion"],
        description: "'fecha' si hay un momento concreto (aunque sea aproximado); 'condicion' si depende de que algo pase, sin fecha fija.",
      },
      fecha_objetivo: {
        type: "string",
        description:
          "Requerido si tipo='fecha'. Formato YYYY-MM-DD o YYYY-MM-DDTHH:mm (hora local de Madrid) — interpreta " +
          "'el jueves', 'mañana', 'en 3 días' contra la fecha actual. Si no dan hora, usa las 09:00.",
      },
      condicion: {
        type: "string",
        description:
          "Requerido si tipo='condicion'. Describe QUÉ hay que verificar y CÓMO (ej. 'la factura F260042 de " +
          "SINFONIA aparece pagada en Holded') — se revisa periódicamente con las herramientas de solo lectura " +
          "disponibles.",
      },
      instruccion: {
        type: "string",
        description:
          "Qué hacer exactamente cuando llegue el momento — autocontenida, con todo el contexto necesario " +
          "(montos, nombres, empresa) porque se ejecutará SIN el historial de esta conversación.",
      },
      contexto: {
        type: "string",
        description: "Frase corta de dónde viene esto (ej. 'anotación cashflow — SINFONIA S36', 'correo de Alberto sobre NEWYORK') — para identificarlo en los avisos.",
      },
      resumen_para_el_usuario: {
        type: "string",
        description: "Una frase corta confirmando qué se programó y para cuándo/bajo qué condición — se le muestra directo al usuario.",
      },
    },
    required: ["tipo", "instruccion", "contexto", "resumen_para_el_usuario"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) {
      return "Error: no se pudo determinar el chat de Telegram para avisar cuando se dispare esta acción.";
    }

    const tipo = input.tipo === "condicion" ? "condicion" : "fecha";
    const instruccion = typeof input.instruccion === "string" ? input.instruccion.trim() : "";
    const contexto = typeof input.contexto === "string" ? input.contexto.trim() : "";
    const resumen = typeof input.resumen_para_el_usuario === "string" ? input.resumen_para_el_usuario.trim() : "";

    if (!instruccion) return "Error: falta 'instruccion'.";
    if (!contexto) return "Error: falta 'contexto'.";

    let fechaObjetivo: string | undefined;
    if (tipo === "fecha") {
      const raw = typeof input.fecha_objetivo === "string" ? input.fecha_objetivo.trim() : "";
      if (!FECHA_HORA_RE.test(raw)) {
        return "Error: 'fecha_objetivo' debe tener formato YYYY-MM-DD o YYYY-MM-DDTHH:mm.";
      }
      fechaObjetivo = raw.includes("T") ? raw : `${raw}T09:00`;
    }

    const condicion = tipo === "condicion" ? (typeof input.condicion === "string" ? input.condicion.trim() : "") : undefined;
    if (tipo === "condicion" && !condicion) {
      return "Error: falta 'condicion' para una acción de tipo condicion.";
    }

    const accion = await programarAccion({ chatId, tipo, fechaObjetivo, condicion, instruccion, contexto });

    const cuando =
      tipo === "fecha"
        ? `Programado para ${fechaObjetivo}`
        : `Se revisará periódicamente: ${condicion}`;

    await sendTelegramMessageWithButtons(
      chatId,
      `📅 ${resumen || contexto}\n\n${cuando}${accion.calendarEventId ? "\n🗓️ Evento creado en el calendario." : ""}`,
      [[{ text: "❌ Cancelar programación", callback_data: `accprog_cancelar:${accion.id}` }]]
    );

    return `Acción programada (id ${accion.id}) — se mostró la confirmación al usuario con botón para cancelar.`;
  },
};
