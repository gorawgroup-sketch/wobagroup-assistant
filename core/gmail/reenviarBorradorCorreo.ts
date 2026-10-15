import { actualizarMessageIdBorrador, type BorradorCorreo } from "./emailDraftStore";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import type { InlineKeyboardButton } from "../telegram/types";

/** Los mismos botones que se mostraron al proponer el borrador (proponer_envio_correo, declaración de gastos sin soporte). */
export function botonesBorradorCorreo(id: string): InlineKeyboardButton[][] {
  return [
    [{ text: "📤 Enviar así", callback_data: `draft_enviar:${id}` }, { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${id}` }],
    [{ text: "❌ No enviar", callback_data: `draft_cancelar:${id}` }],
  ];
}

export function textoBorradorCorreo(b: BorradorCorreo, encabezado?: string): string {
  const adjuntos = b.adjuntosDrive?.length ? [`📎 Adjunto: ${b.adjuntosDrive.map((a) => a.nombre).join(", ")}`] : [];
  return [...(encabezado ? [encabezado, ""] : []), `✉️ Borrador de correo para ${b.to}:`, ...(b.cc ? [`Con copia a: ${b.cc}`] : []), `Asunto: ${b.subject}`, ...adjuntos, "", b.cuerpo].join("\n");
}

/**
 * Vuelve a poner al final del chat un borrador de correo que sigue pendiente (Carlos borró por error los mensajes de la
 * respuesta a Kelly y su declaración, 14-10-2026): mismo texto, mismos botones, y el borrador pasa a apuntar al mensaje nuevo
 * para que «Editar» y «Enviar» actúen sobre él. No envía ni cancela nada.
 */
export async function reenviarBorradorCorreo(b: BorradorCorreo, encabezado: string): Promise<number> {
  const messageId = await sendTelegramMessageWithButtons(b.chatId, textoBorradorCorreo(b, encabezado), botonesBorradorCorreo(b.id));
  await actualizarMessageIdBorrador(b.id, messageId);
  return messageId;
}
