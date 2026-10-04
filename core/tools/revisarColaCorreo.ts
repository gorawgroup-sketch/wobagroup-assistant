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
    "Revisa todos los correos sin leer: primero ejecuta la fase automática de gastos conforme a su configuración " +
    "y después sincroniza los pendientes para revisión manual del más antiguo al más nuevo. Solo informa creación " +
    "y conciliación cuando el resultado está verificado. Los pendientes necesitan aprobación individual; usa " +
    "procesar_siguiente_correo_cola solo cuando el usuario quiera empezar o avanzar. No confundir simulación con ejecución.",
  input_schema: { type: "object", properties: {} },
  handler: async (_input, context) => {
    const resultado = await revisarCorreoNuevo(true, context?.chatId);
    const { resumenAutomatico } = await import("../gmail/automatico/service");
    const auto = resultado.automatico ? resumenAutomatico(resultado.automatico) : "";
    if (auto) return auto + (resultado.activoBloqueando ? `\nContinúa primero con el correo activo: ${resultado.activoBloqueando.asunto}.` : "\nLos pendientes se revisan uno a uno; el siguiente requiere tu indicación.");
    if (resultado.activoBloqueando) {
      return `La cola está sincronizada, pero ya hay un correo activo esperando resolución: "${resultado.activoBloqueando.asunto}" de ${resultado.activoBloqueando.de}. No procesé otro encima.`;
    }
    if (resultado.correosRevisados === 0) {
      return "La cola quedó sincronizada. No apareció ningún hilo sin leer nuevo para agregar; si había pendientes, se conservaron en su orden.";
    }
    return `Cola sincronizada: agregué ${resultado.correosRevisados} hilo(s) sin leer y ofrecí empezar por el más antiguo. No marqué ninguno como leído antes de terminarlo.`;
  },
};
