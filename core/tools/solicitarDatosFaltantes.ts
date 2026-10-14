import { prepararSolicitudesDatos } from "../gastos/datosFaltantes/prepararSolicitudes";
import type { ToolDefinition } from "./types";

/**
 * Pedir al creador de un gasto lo que falta para registrarlo y conciliarlo (Carlos, 2026-10-14). El mismo correo sale solo, con aprobación, de
 * core/jobs/solicitarDatosFaltantes.ts; esta herramienta es para pedirlo a demanda («pídele a Kelly la fecha del ticket de Crepes & Waffles»).
 * Solo PREPARA el correo (resumen con Ver / Enviar / Cancelar); no sale nada hasta que un superadministrador pulse «Enviar».
 */
export const solicitarDatosFaltantesTool: ToolDefinition = {
  name: "solicitar_datos_faltantes_a_creadores",
  description:
    "Cuando un gasto recibido por correo está pendiente porque al comprobante le falta un dato (fecha, moneda, comercio o empresa), prepara el correo " +
    "profesional que se le manda a QUIEN ENVIÓ el comprobante pidiéndole justo lo que falta para poder registrar y conciliar el gasto. Agrupa por persona " +
    "(un solo correo con todo lo suyo) y lo muestra con los botones «Ver correo» / «Enviar» / «Cancelar»; no envía nada hasta que un superadministrador " +
    "pulse «Enviar». Úsala cuando pidan pedirle a alguien un dato de un gasto pendiente, o cuando no tengas información suficiente para crear un gasto: " +
    "en vez de preguntarle a Carlos, pídeselo al creador. Sin `ids` incluye todos los pendientes de datos de correo que aún no se hayan pedido; con `ids` " +
    "(los ids de los pendientes) solo esos.",
  input_schema: {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string" }, description: "Ids de los gastos pendientes de datos a pedir. Opcional." } },
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram donde mostrar el correo.";
    const ids = Array.isArray(input.ids) ? input.ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : undefined;
    try { return await prepararSolicitudesDatos(chatId, { ...(ids && ids.length ? { ids } : {}) }); }
    catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
  },
};
