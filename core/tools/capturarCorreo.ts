import { buscarMensajes, obtenerResumenCorreo, obtenerCuerpoCompletoCorreo } from "../gmail/client";
import { registrarCaptura } from "../knowledge/capturaSheet";
import type { ToolDefinition } from "./types";

/**
 * Guarda el contenido REAL de un correo entrante en la base de conocimiento
 * — a diferencia de un mensaje "CAPTURA: ..." normal (que guarda tal cual
 * el texto que escribió la persona en Telegram), esto va y LEE el correo
 * de verdad (asunto, remitente, cuerpo completo, no el snippet truncado de
 * Gmail) antes de capturarlo. Nace de una corrección real: al pedir
 * "CAPTURA la información del correo que llegó de X", el sistema guardaba
 * literalmente esa instrucción como si fuera el conocimiento, sin haber
 * leído el correo — así que después no había nada útil que consultar.
 */
export const capturarCorreoTool: ToolDefinition = {
  name: "capturar_correo",
  description:
    "Lee un correo real del buzón (asistente@wobagroup.com) y guarda su contenido completo (asunto, " +
    "remitente, cuerpo) en la base de conocimiento permanente. Úsala cuando pidan 'capturar', 'guardar' o " +
    "'que recuerdes' la información de un correo que llegó o que mencionan — nunca inventes ni resumas el " +
    "contenido de memoria, esta herramienta va a leer el correo real. Si no se especifica cuál correo, usa " +
    "el más reciente de la bandeja de entrada.",
  input_schema: {
    type: "object",
    properties: {
      busqueda: {
        type: "string",
        description:
          "Términos para encontrar el correo correcto (remitente, asunto, tema) — puede ser lenguaje " +
          "natural o una consulta de Gmail (ej. 'from:proveedor@dominio.com', 'subject:factura'). Si no se " +
          "da o no se sabe cuál es, se omite y se toma el correo más reciente.",
      },
      empresas: {
        type: "array",
        items: { type: "string", enum: ["WOBA", "EWORKS", "Footprint", "General"] },
        description:
          "A qué empresa(s) del grupo corresponde esta información, si se puede determinar del contexto " +
          "de la conversación (quién lo pidió, de qué se habla). Si no es evidente, PREGÚNTALE al usuario " +
          "a qué empresa corresponde antes de llamar esta herramienta, en vez de adivinar — así la captura " +
          "queda correctamente etiquetada. Usa 'General' solo si de verdad aplica a las tres.",
      },
    },
  },
  handler: async (input) => {
    const busqueda = typeof input.busqueda === "string" ? input.busqueda.trim() : "";
    const empresas = Array.isArray(input.empresas) ? input.empresas.filter((e): e is string => typeof e === "string") : [];
    const query = busqueda ? `${busqueda} in:inbox` : "in:inbox";

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
        : "No encontré ningún correo en la bandeja de entrada.";
    }

    const [resumen, cuerpo] = await Promise.all([obtenerResumenCorreo(ids[0]), obtenerCuerpoCompletoCorreo(ids[0])]);

    const contenido = [`De: ${resumen.de}`, `Asunto: ${resumen.asunto}`, `Fecha: ${resumen.fecha}`, "", cuerpo].join("\n");

    await registrarCaptura(contenido, "correo entrante (capturado)", empresas);

    const empresasLabel = empresas.length > 0 ? ` (${empresas.join(", ")})` : "";
    return (
      `Capturado el correo "${resumen.asunto}" de ${resumen.de}${empresasLabel} ` +
      `(${cuerpo.length} caracteres del cuerpo) — ya está en la base de conocimiento, disponible para ` +
      "futuras consultas."
    );
  },
};
