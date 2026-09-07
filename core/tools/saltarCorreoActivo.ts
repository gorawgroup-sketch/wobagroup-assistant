import { saltarCorreoActivo } from "../jobs/revisarCorreoNuevo";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos: "asegúrate de que cuando algo se bloquee pueda continuar con la
 * revisión de correos sin tener que venir a esta instancia, que la inteligencia del sistema lo
 * reconozca y, mientras soluciona eso, podamos continuar revisando correos, porque cada vez que
 * hacemos un arreglo aquí, bloqueamos todo el trabajo." Antes, la única forma de saltar el correo
 * ACTIVO de la cola (el que bloquea pasar al siguiente) era tocar un botón específico que solo
 * aparecía tras 48h estancado, o esperar el resumen de fin de día — nada alcanzable con una
 * instrucción normal en el momento. Misma acción que "🗑️ Descartar y liberar", ahora también en
 * texto libre.
 */
export const saltarCorreoActivoTool: ToolDefinition = {
  name: "saltar_correo_activo",
  description:
    "Salta/descarta el correo ACTIVO de la cola de revisión de correo — el que está bloqueando pasar " +
    "al siguiente — y ofrece continuar con el resto. Úsala cuando el usuario pida explícitamente saltar, " +
    "posponer o dejar de lado el correo/pregunta actual para seguir revisando otros (ej. 'sáltate este " +
    "correo', 'este está atascado, sigue con el siguiente', 'déjalo por ahora y continúa'). NO la uses " +
    "para responder una pregunta pendiente normal (esa se resuelve respondiéndola, no saltándola) — solo " +
    "cuando el usuario de verdad quiere dejarla de lado por ahora. Marca el correo como leído en Gmail.",
  input_schema: { type: "object", properties: {} },
  handler: async (_input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede saltar ningún correo.";
    }
    const resultado = await saltarCorreoActivo(chatId);
    return `${resultado} No hace falta que lo repitas, ya se le puede confirmar al usuario (y la pregunta de "¿seguimos con el siguiente?" ya se mandó aparte si correspondía).`;
  },
};
