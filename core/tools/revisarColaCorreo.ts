import { revisarCorreoNuevo } from "../jobs/revisarCorreoNuevo";
import type { ToolDefinition } from "./types";

/**
 * Punto conversacional único para la misma cola que usan el cron y /revisarcorreo.
 *
 * Hallazgo real de auditoría (Carlos, panel web, 2026-09-15): esta descripción decía "procesa uno por
 * uno", pero esta herramienta SOLO sincroniza la cola contra is:unread real y la ordena/lista — nunca
 * descarga ni procesa ningún correo por sí sola (eso solo pasaba, antes, al presionar el botón "▶️ Sí,
 * siguiente" en Telegram). Esa descripción exagerada llevó a Claude a decir "voy a procesarlos" sin
 * tener con qué hacerlo de verdad. El procesamiento real vive en procesar_siguiente_correo_cola — úsala
 * a continuación cuando el usuario pida avanzar/procesar, no des por hecho que esta ya lo hizo.
 */
export const revisarColaCorreoTool: ToolDefinition = {
  name: "revisar_cola_correo",
  description:
    "Sincroniza y muestra la cola de correos SIN LEER: toma únicamente is:unread in:inbox, la ordena del más " +
    "antiguo al más nuevo y agrega los hilos nuevos. NO descarga ni procesa ningún correo por sí sola — solo " +
    "sincroniza el estado de la cola. Úsala para pedidos generales como 'revisa los correos', 'qué correos " +
    "tengo sin leer' o 'sincroniza la bandeja'. Si el usuario además pide procesarlos/avanzar ('revisa y " +
    "procésalos', 'sigue con la cola'), usa también procesar_siguiente_correo_cola después de esta — esa es " +
    "la que de verdad descarga, lee y decide cada correo. Si un correo leído se volvió a marcar sin leer, " +
    "esta cola lo incorpora de nuevo. No la uses para un correo puntual expresamente identificado; para eso " +
    "existe revisar_correo_puntual.",
  input_schema: { type: "object", properties: {} },
  handler: async (_input, context) => {
    const resultado = await revisarCorreoNuevo(true, context?.chatId);
    if (resultado.activoBloqueando) {
      return `La cola está sincronizada, pero ya hay un correo activo esperando resolución: "${resultado.activoBloqueando.asunto}" de ${resultado.activoBloqueando.de}. No procesé otro encima.`;
    }
    if (resultado.correosRevisados === 0) {
      return "La cola quedó sincronizada. No apareció ningún hilo sin leer nuevo para agregar; si había pendientes, se conservaron en su orden.";
    }
    return `Cola sincronizada: agregué ${resultado.correosRevisados} hilo(s) sin leer y ofrecí empezar por el más antiguo. No marqué ninguno como leído antes de terminarlo.`;
  },
};
