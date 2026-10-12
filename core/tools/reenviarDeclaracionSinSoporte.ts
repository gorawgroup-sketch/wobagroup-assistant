import type { ToolDefinition } from "./types";
import { reenviarDeclaracion } from "../soportes/declaracion/reenviarDeclaracion";
const EMPRESAS = ["WOBA", "EWORKS", "Footprint"] as const;

/**
 * «Reenvíale la declaración a German con disculpa, que no iba adjunta» / «vuelve a mandarle la declaración a X»:
 * reutiliza la declaración ya generada (mismo documento de Drive), responde en el hilo del correo anterior y propone el
 * correo con el adjunto y las instrucciones. Nada sale sin «Enviar así». No genera un documento nuevo ni toca Holded.
 */
export const reenviarDeclaracionSinSoporteTool: ToolDefinition = {
  name: "reenviar_declaracion_gastos_sin_soporte",
  description:
    "Vuelve a proponer el correo con la declaración «GASTOS SIN SOPORTE» ya generada de una persona, adjuntando el mismo documento de Drive " +
    "y respondiendo en el hilo del correo anterior, con instrucciones claras (descargar, firmar, responder con foto o PDF). Úsala cuando el " +
    "correo anterior salió sin el adjunto (motivo sin_adjunto: pide disculpas) o la persona dice que no lo recibió (motivo no_recibida). " +
    "No crea una declaración nueva: para eso está preparar_declaracion_gastos_sin_soporte. Carlos aprueba el borrador con un botón.",
  input_schema: {
    type: "object",
    required: ["motivo"],
    properties: {
      motivo: { type: "string", enum: ["sin_adjunto", "no_recibida"], description: "sin_adjunto: el correo anterior fue sin documento (con disculpa). no_recibida: reenvío simple." },
      declaracion_id: { type: "string", description: "Id de la declaración, si se conoce. Si falta, se usa la última pendiente de firma de la persona." },
      empresa: { type: "string", enum: [...EMPRESAS] },
      email: { type: "string", description: "Correo de la persona (obligatorio si no se pasa declaracion_id)." },
    },
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram.";
    const motivo = input.motivo === "no_recibida" ? "no_recibida" : "sin_adjunto";
    const empresa = typeof input.empresa === "string" && (EMPRESAS as readonly string[]).includes(input.empresa) ? (input.empresa as (typeof EMPRESAS)[number]) : undefined;
    try {
      const r = await reenviarDeclaracion({
        chatId, motivo, empresa,
        declaracionId: typeof input.declaracion_id === "string" ? input.declaracion_id.trim() || undefined : undefined,
        email: typeof input.email === "string" ? input.email.trim() || undefined : undefined,
      });
      return `Listo — el reenvío de la declaración ${r.declaracion.nombreArchivo} a ${r.declaracion.email} (${r.enElHilo ? "en el hilo del correo anterior" : "en correo nuevo"}, con el documento adjunto) ya se mostró en Telegram con botones. No hace falta repetirlo: dile al usuario que pulse «Enviar así» cuando lo revise.`;
    } catch (error) {
      return `No pude preparar el reenvío: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
