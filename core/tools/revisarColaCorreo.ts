import { revisarCorreoNuevo } from "../jobs/revisarCorreoNuevo";
import type { ToolDefinition } from "./types";

/** Punto conversacional único para la misma cola que usan el cron y /revisarcorreo. */
export const revisarColaCorreoTool: ToolDefinition = {
  name: "revisar_cola_correo",
  description:
    "Inicia o sincroniza la revisión profesional de correos SIN LEER: toma únicamente is:unread in:inbox, " +
    "ordena del más antiguo al más nuevo, procesa uno por uno, evita duplicados y solo marca cada hilo como " +
    "leído al completar todas sus decisiones. Úsala para pedidos generales como 'revisa los correos', " +
    "'procesa los no leídos' o 'continúa con la bandeja'. Si un correo leído se volvió a marcar sin leer, esta " +
    "cola lo incorpora de nuevo. No la uses para un correo puntual expresamente identificado; para eso existe " +
    "revisar_correo_puntual.",
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
