import { prepararAvisoFormato } from "../soportes/avisoFormatoTelegram";
import type { ToolDefinition } from "./types";

/**
 * Pedido de Carlos (2026-10-14): escribir a todos los que ya recibieron una solicitud de soportes, agradecer a quien ya los envió y
 * explicar cómo enviar cada soporte (un correo aparte, con el detalle del gasto, el valor, la moneda y la empresa en el asunto). Hasta
 * entonces el asistente decía que «no puede mezclar» eso en un correo masivo porque el proceso de soportes solo sabía pedir cargos nuevos.
 * Esta herramienta solo PREPARA el aviso con sus botones; el envío lo hace el botón «Enviar» (solo superadmin).
 */
export const avisoFormatoSoportesTool: ToolDefinition = {
  name: "preparar_aviso_formato_soportes",
  description:
    "Prepara un correo para TODAS las personas que ya recibieron una solicitud de soportes (facturas o recibos de gastos con tarjeta): agradece " +
    "a quien ya los envió y explica a quien no cómo enviarlos (cada soporte en un correo aparte y nuevo a asistente@wobagroup.com, SIN responder " +
    "al correo de la solicitud, con el detalle del gasto, el valor, la moneda y la empresa en el asunto). Úsala cuando el usuario pida " +
    "reenviar, recordar, agradecer o aclarar el formato a quienes ya se les pidieron soportes. Usa los destinatarios que ya constan en el registro " +
    "de solicitudes (con su email confirmado), NO necesita CSV ni que el usuario liste a nadie. Solo muestra el resumen con los botones " +
    "«Enviar» / «Ver correo» / «Cancelar»: no envía nada hasta que un superadministrador pulse «Enviar». NO uses proponer_envio_correo para esto. " +
    "Si el usuario quiere dejar fuera a alguien (por ejemplo, a sí mismo), pasa su nombre en `excluir`.",
  input_schema: {
    type: "object",
    properties: {
      excluir: {
        type: "array",
        items: { type: "string" },
        description: "Nombres completos (o al menos nombre y apellido) de personas a dejar fuera del aviso. Opcional.",
      },
    },
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram donde mostrar el aviso.";
    const excluir = Array.isArray(input.excluir) ? input.excluir.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
    return prepararAvisoFormato(chatId, { excluir });
  },
};
