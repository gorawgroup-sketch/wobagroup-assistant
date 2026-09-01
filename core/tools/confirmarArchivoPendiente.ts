import { consumirPropuestaClasificacionPorChat } from "../documental/classificationStore";
import { archivarDocumentoEnDrive } from "../documental/archiveFile";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos, tras un caso real: le mandamos una propuesta
 * de archivar un documento con botones ("✅ Sí, archivar aquí" / "✏️ Elegir
 * otra carpeta"), pero en vez de presionarlos respondió en texto libre
 * ("Archívalo en la carpeta que recomiendas y responde el correo...") — y
 * el asistente conversacional no tenía ningún contexto de esa propuesta
 * (vive en un store aparte, no en el historial de chat), así que le pidió
 * de nuevo datos que ya se le habían mostrado. Esta tool le da al chat
 * normal la misma capacidad que el botón: confirmar la propuesta de
 * archivo pendiente para este chat. buildSystemPromptDinamico (core/claude/
 * client.ts) avisa cuando hay una propuesta esperando, para que el modelo
 * sepa que existe y la use si el mensaje del usuario aplica.
 */
export const confirmarArchivoPendienteTool: ToolDefinition = {
  name: "confirmar_archivo_pendiente",
  description:
    "Confirma (archiva en Drive) la propuesta de clasificación de documento que está pendiente de " +
    "respuesta para ESTE chat — el mismo efecto que si el usuario presionara el botón '✅ Sí, archivar " +
    "aquí'. Úsala cuando el usuario responda en texto libre a una propuesta de archivo ya mostrada (en " +
    "vez de tocar el botón), confirmando que sí quiere archivarlo en la carpeta sugerida (ej. 'archívalo " +
    "ahí', 'sí, guárdalo', 'dale, en esa carpeta está bien'). Si el usuario en cambio pide una carpeta " +
    "DISTINTA a la sugerida, no uses esta tool — dile que archive por Telegram con el botón '✏️ Elegir " +
    "otra carpeta', o pídele la carpeta correcta y usa las tools de Drive para proponerla ahí. Devuelve el " +
    "resultado real (incluyendo el link de Drive si se archivó con éxito) para que puedas usarlo, por " +
    "ejemplo, en un correo de confirmación que el usuario te pida redactar a continuación.",
  input_schema: { type: "object", properties: {} },
  handler: async (_input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede confirmar ninguna propuesta.";
    }

    const propuesta = await consumirPropuestaClasificacionPorChat(chatId);
    if (!propuesta) {
      return "No hay ninguna propuesta de archivo pendiente para este chat (puede que ya se haya " +
        "procesado, o que haya expirado — vuelve a mandar el archivo si hace falta).";
    }

    const resultado = await archivarDocumentoEnDrive(propuesta);
    if (!resultado.ok) {
      return `No se pudo archivar "${propuesta.nombreArchivoOriginal}": ${resultado.mensaje}`;
    }

    const notaCorreoOrigen = propuesta.correoOrigen
      ? ` Este documento vino de un correo — de: ${propuesta.correoOrigen.de}, asunto: "${propuesta.correoOrigen.asunto}". ` +
        `Si el usuario pidió responderlo, usa proponer_envio_correo con destinatario="${propuesta.correoOrigen.de}", ` +
        `thread_id="${propuesta.correoOrigen.threadId}" y message_id_header="${propuesta.correoOrigen.messageIdHeader}" ` +
        "para que quede como una respuesta real en el mismo hilo, no un correo nuevo."
      : "";

    return (
      `Archivado con éxito: "${propuesta.nombreArchivoOriginal}" (empresa ${propuesta.clasificacion.empresa}, ` +
      `carpeta "${propuesta.clasificacion.carpetaSugerida}"). ${resultado.mensaje} ` +
      `Link de Drive: ${resultado.webViewLink ?? "(no disponible)"}.${notaCorreoOrigen}`
    );
  },
};
