import { crearBorradorCorreo, actualizarMessageIdBorrador } from "../gmail/emailDraftStore";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import type { ToolDefinition } from "./types";

/**
 * Permite proponer el envío de un correo desde cualquier conversación normal
 * (no solo desde el flujo automático de revisión de correo entrante). NUNCA
 * envía nada por sí sola — solo crea un borrador y lo muestra por Telegram
 * con los mismos botones de aprobación (Enviar así / Editar / No enviar)
 * que ya usa el resto del sistema. El envío real solo ocurre si el usuario
 * presiona "Enviar así".
 */
export const proponerEnvioCorreoTool: ToolDefinition = {
  name: "proponer_envio_correo",
  description:
    "Prepara un borrador de correo y lo muestra por Telegram con botones para que el usuario lo " +
    "apruebe, edite o cancele. Úsala cuando te pidan enviar, mandar o contestar algo por correo — " +
    "nunca respondas que no puedes enviar correos: en vez de eso, usa esta herramienta para proponerlo. " +
    "El envío real NUNCA ocurre al llamar esta herramienta, solo cuando el usuario aprueba el botón " +
    "'Enviar así' después. Si estás RESPONDIENDO un correo real del que ya tienes thread_id y " +
    "message_id_header (ej. porque venían en el aviso de una propuesta de archivo pendiente), pásalos — " +
    "así el correo queda enhebrado como una respuesta real en el mismo hilo (con 'Re:' y en la misma " +
    "conversación de Gmail), en vez de mandarse como un correo nuevo sin relación aparente.",
  input_schema: {
    type: "object",
    properties: {
      destinatario: {
        type: "string",
        description: "Dirección de correo del destinatario (ej. carlos@wobagroup.com).",
      },
      asunto: { type: "string", description: "Asunto del correo." },
      cuerpo: {
        type: "string",
        description: "Cuerpo del correo en texto plano, tono profesional y conciso, en español.",
      },
      thread_id: {
        type: "string",
        description: "SOLO si es una respuesta a un correo real ya identificado: su threadId de Gmail.",
      },
      message_id_header: {
        type: "string",
        description:
          "SOLO si es una respuesta a un correo real ya identificado: su Message-ID de correo (para " +
          "enhebrarlo con In-Reply-To/References y anteponer 'Re:' al asunto).",
      },
    },
    required: ["destinatario", "asunto", "cuerpo"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) {
      return "Error: no se pudo determinar el chat de Telegram donde mostrar el borrador.";
    }

    const destinatario = typeof input.destinatario === "string" ? input.destinatario.trim() : "";
    const asunto = typeof input.asunto === "string" ? input.asunto.trim() : "";
    const cuerpo = typeof input.cuerpo === "string" ? input.cuerpo.trim() : "";
    const threadId = typeof input.thread_id === "string" ? input.thread_id.trim() || undefined : undefined;
    const messageIdHeader =
      typeof input.message_id_header === "string" ? input.message_id_header.trim() || undefined : undefined;

    if (!destinatario || !asunto || !cuerpo) {
      return "Error: faltan datos (destinatario, asunto o cuerpo) para preparar el borrador.";
    }

    const borrador = await crearBorradorCorreo({
      chatId,
      messageId: 0,
      to: destinatario,
      subject: asunto,
      cuerpo,
      threadId,
      messageIdHeader,
    });

    const texto = [`✉️ Borrador de correo para ${destinatario}:`, `Asunto: ${asunto}`, "", cuerpo].join("\n");

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "📤 Enviar así", callback_data: `draft_enviar:${borrador.id}` },
        { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` },
      ],
      [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
    ]);

    await actualizarMessageIdBorrador(borrador.id, messageId);

    return "Borrador preparado y mostrado al usuario por Telegram con botones para aprobar, editar o cancelar el envío.";
  },
};
