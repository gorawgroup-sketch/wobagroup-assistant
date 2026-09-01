import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { consumirPropuestaAccionCorreo, type PropuestaAccionCorreo } from "./emailActionStore";
import { guardarPendienteOrientacionCorreo } from "./emailOrientationStore";
import { crearBorradorCorreo, actualizarMessageIdBorrador, actualizarCuerpoBorrador, obtenerBorradorCorreo, consumirBorradorCorreo } from "./emailDraftStore";
import { guardarPendienteEdicionBorrador } from "./emailDraftEditStore";
import {
  crearOfertaResponderCorreo,
  actualizarMessageIdOfertaResponder,
  consumirOfertaResponderCorreo,
} from "./emailReplyOfferStore";
import { enviarCorreo } from "./client";
import { askClaude } from "../claude/client";
import type { TelegramCallbackQuery } from "../telegram/types";

/** Extrae la dirección pura de un header "From" tipo `Nombre <correo@dominio.com>`. */
function extraerDireccion(de: string): string {
  const match = de.match(/<([^>]+)>/);
  return match ? match[1] : de.trim();
}

/**
 * Genera un borrador de respuesta y lo ofrece por Telegram con botones de
 * envío. Nunca envía nada por sí sola — solo redacta y muestra.
 */
export async function generarBorradorYOfrecer(
  chatId: number,
  de: string,
  asunto: string,
  threadId: string | undefined,
  messageIdHeader: string | undefined,
  contextoInvestigacion: string
): Promise<void> {
  try {
    const promptBorrador =
      `Redacta el CUERPO de un correo de respuesta (solo el texto del cuerpo, sin asunto, sin encabezados, ` +
      `sin firma automática) para responder este correo — Asunto: "${asunto}". ` +
      `Contexto e investigación ya realizada: ${contextoInvestigacion}. ` +
      `Tono profesional y conciso, en español. Devuelve únicamente el texto del cuerpo del correo.`;

    const cuerpo = await askClaude(promptBorrador);
    const to = extraerDireccion(de);

    const borrador = await crearBorradorCorreo({
      chatId,
      messageId: 0,
      to,
      subject: asunto,
      threadId,
      messageIdHeader,
      cuerpo,
    });

    const texto = [`✉️ Borrador de respuesta a ${to}:`, "", cuerpo].join("\n");

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "📤 Enviar así", callback_data: `draft_enviar:${borrador.id}` },
        { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` },
      ],
      [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
    ]);

    await actualizarMessageIdBorrador(borrador.id, messageId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] Error generando borrador de respuesta:", message);
    await sendTelegramMessage(chatId, `⚠️ No se pudo generar el borrador de respuesta: ${message}`);
  }
}

/**
 * Pedido explícito de Carlos, tras un caso real: cuando un documento que
 * llegó por correo parece pedir que se recuerde/registre (ver
 * pareceIntencionDeCaptura en classifyFile.ts), además de proponer
 * archivarlo y capturarlo como conocimiento, hay que preguntar explícitamente
 * si se responde ese correo — SIN gastar todavía en redactar el borrador
 * (eso solo ocurre si contesta que sí, ver handleEmailActionCallback). Nunca
 * envía ni redacta nada por sí sola.
 */
export async function ofrecerResponderCorreo(
  chatId: number,
  de: string,
  asunto: string,
  threadId: string | undefined,
  messageIdHeader: string | undefined,
  contexto: string
): Promise<void> {
  try {
    const oferta = await crearOfertaResponderCorreo({ chatId, messageId: 0, de, asunto, threadId, messageIdHeader, contexto });

    const messageId = await sendTelegramMessageWithButtons(
      chatId,
      `✉️ ¿Quieres que responda el correo "${asunto}" de ${de}?`,
      [
        [
          { text: "✅ Sí, responder", callback_data: `email_responder_si:${oferta.id}` },
          { text: "❌ No", callback_data: `email_responder_no:${oferta.id}` },
        ],
      ]
    );

    await actualizarMessageIdOfertaResponder(oferta.id, messageId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] Error ofreciendo responder el correo:", message);
  }
}

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Maneja los botones de una propuesta de acción sobre un correo
 * (email_proceder / email_descartar / email_orientar).
 *
 * "Proceder" NUNCA ejecuta el texto del correo directamente — dispara al
 * asistente normal (askClaude, con su registro de tools ya existente, todas
 * de solo lectura o ya protegidas con su propio botón de aprobación) para
 * que investigue y reporte. Los tools de escritura real (cashflow, subida a
 * Drive) no están en ese registro, así que este camino nunca puede
 * disparar una escritura por sí solo.
 */
export async function handleEmailActionCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");

  // Store distinto (emailReplyOfferStore) al de las demás acciones email_* de
  // esta función (emailActionStore) — se resuelve ANTES de tocar
  // consumirPropuestaAccionCorreo, que no encontraría este id.
  if (accion === "email_responder_si" || accion === "email_responder_no") {
    const oferta = await consumirOfertaResponderCorreo(id);
    if (!oferta) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible.");
      return;
    }

    if (accion === "email_responder_no") {
      await answerCallbackQuerySafe(callback.id, "Ok.");
      await editTelegramMessage(oferta.chatId, oferta.messageId, `Ok — no respondo el correo "${oferta.asunto}".`, []);
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Redactando...");
    await editTelegramMessage(oferta.chatId, oferta.messageId, `🔄 Redactando respuesta para "${oferta.asunto}"...`, []);
    await generarBorradorYOfrecer(oferta.chatId, oferta.de, oferta.asunto, oferta.threadId, oferta.messageIdHeader, oferta.contexto);
    return;
  }

  const propuesta = await consumirPropuestaAccionCorreo(id);

  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (accion === "email_descartar") {
    await answerCallbackQuerySafe(callback.id, "Descartado.");
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `❌ Descartado — ${propuesta.asunto} (${propuesta.de})`,
      []
    );
    return;
  }

  if (accion === "email_orientar") {
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — respóndeme qué quieres que haga con este correo ("${propuesta.asunto}", de ${propuesta.de}).`,
      []
    );
    await guardarPendienteOrientacionCorreo({
      chatId: propuesta.chatId,
      messageId: propuesta.messageId,
      de: propuesta.de,
      asunto: propuesta.asunto,
      resumen: propuesta.resumen,
      threadId: propuesta.threadId,
      messageIdHeader: propuesta.messageIdHeader,
    });
    return;
  }

  // email_proceder
  await answerCallbackQuerySafe(callback.id, "Procesando...");
  await editTelegramMessage(
    propuesta.chatId,
    propuesta.messageId,
    `🔄 Procesando — ${propuesta.asunto} (${propuesta.de})\n\nEsto puede tardar uno o dos minutos si hace falta explorar Drive o Holded.`,
    []
  ).catch((error) => console.error("[emailCallbackHandler] No se pudo mostrar 'Procesando...' (no crítico):", error));

  try {
    const instruccion =
      `Se aprobó proceder con esta acción propuesta a partir de un correo entrante. ` +
      `Correo — De: ${propuesta.de}. Asunto: ${propuesta.asunto}. Resumen: ${propuesta.resumen}. ` +
      `Acción a realizar: ${propuesta.accionSugerida}. ` +
      `Investiga y ejecuta lo que corresponda con las herramientas disponibles, y reporta el resultado.`;

    const respuesta = await askClaude(instruccion, propuesta.chatId);

    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ Procesado — ${propuesta.asunto} (${propuesta.de})\n\n${respuesta}`,
      []
    );

    if (propuesta.tipo === "necesita_respuesta" || propuesta.tipo === "instruccion_jefe") {
      await generarBorradorYOfrecer(
        propuesta.chatId,
        propuesta.de,
        propuesta.asunto,
        propuesta.threadId,
        propuesta.messageIdHeader,
        respuesta
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] Error procediendo con la acción:", message);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ Error al procesar — ${propuesta.asunto} (${propuesta.de})\n\n${message}`,
      []
    );
  }
}

/**
 * Continúa el flujo cuando el usuario responde con orientación específica
 * (después de pulsar "✏️ Dar instrucciones específicas"). Mismo camino
 * seguro que "Proceder": pasa por askClaude con su registro de tools ya
 * existente, nunca ejecuta nada fuera de eso.
 */
export async function continuarConOrientacion(
  chatId: number,
  de: string,
  asunto: string,
  resumen: string,
  instruccionUsuario: string,
  threadId?: string,
  messageIdHeader?: string
): Promise<void> {
  await sendTelegramMessage(chatId, "🔄 Procesando tu instrucción — esto puede tardar uno o dos minutos...").catch(
    (error) => console.error("[emailCallbackHandler] No se pudo mostrar 'Procesando...' (no crítico):", error)
  );

  const instruccion =
    `El usuario dio instrucciones específicas sobre un correo entrante. ` +
    `Correo — De: ${de}. Asunto: ${asunto}. Resumen: ${resumen}. ` +
    `Instrucción del usuario: ${instruccionUsuario}. ` +
    `Investiga y ejecuta lo que corresponda con las herramientas disponibles, y reporta el resultado.`;

  const respuesta = await askClaude(instruccion, chatId);
  await sendTelegramMessage(chatId, respuesta);

  const pareceRespuesta = /correo|responder|contestar|email|mail/i.test(instruccionUsuario);
  if (pareceRespuesta) {
    await generarBorradorYOfrecer(chatId, de, asunto, threadId, messageIdHeader, respuesta);
  }
}

/**
 * Maneja los botones de un borrador de respuesta (draft_enviar / draft_editar
 * / draft_cancelar). Solo "draft_enviar" dispara el envío real por Gmail —
 * es el único punto de todo el sistema donde se manda un correo de verdad.
 */
export async function handleDraftCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");

  if (accion === "draft_cancelar") {
    const borrador = await consumirBorradorCorreo(id);
    await answerCallbackQuerySafe(callback.id, "No enviado.");
    if (borrador) {
      await editTelegramMessage(
        borrador.chatId,
        borrador.messageId,
        `❌ No enviado — borrador descartado (para: ${borrador.to}).`,
        []
      );
    }
    return;
  }

  if (accion === "draft_editar") {
    const borrador = await obtenerBorradorCorreo(id);
    if (!borrador) {
      await answerCallbackQuerySafe(callback.id, "Este borrador ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(
      borrador.chatId,
      borrador.messageId,
      `✏️ Ok — mándame el texto completo con el que quieres reemplazar este borrador (para: ${borrador.to}).`,
      []
    );
    await guardarPendienteEdicionBorrador(borrador.chatId, borrador.id);
    return;
  }

  // draft_enviar
  const borrador = await obtenerBorradorCorreo(id);
  if (!borrador) {
    await answerCallbackQuerySafe(callback.id, "Este borrador ya no está disponible.");
    return;
  }

  await answerCallbackQuerySafe(callback.id, "Enviando...");

  try {
    await enviarCorreo({
      to: borrador.to,
      asunto: borrador.subject,
      cuerpo: borrador.cuerpo,
      threadId: borrador.threadId,
      messageIdHeader: borrador.messageIdHeader,
    });

    // Solo se consume (se descarta) el borrador si el envío tuvo éxito —
    // si falla, se conserva para poder reintentar sin perder el texto.
    await consumirBorradorCorreo(id);

    await editTelegramMessage(borrador.chatId, borrador.messageId, `📤 Enviado a ${borrador.to}.`, []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] Error enviando correo:", message);
    await editTelegramMessage(
      borrador.chatId,
      borrador.messageId,
      `⚠️ Error al enviar a ${borrador.to}: ${message}\n\nEl borrador se conserva — puedes volver a intentarlo.`,
      [
        [
          { text: "📤 Enviar así", callback_data: `draft_enviar:${borrador.id}` },
          { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` },
        ],
        [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
      ]
    );
  }
}

/**
 * Continúa el flujo cuando el usuario responde con el texto de reemplazo
 * tras pulsar "✏️ Editar antes de enviar".
 */
export async function continuarConEdicionBorrador(chatId: number, borradorId: string, nuevoTexto: string): Promise<void> {
  const borrador = await actualizarCuerpoBorrador(borradorId, nuevoTexto);
  if (!borrador) {
    await sendTelegramMessage(chatId, "Ese borrador ya no está disponible.");
    return;
  }

  const texto = [`✉️ Borrador actualizado — para ${borrador.to}:`, "", nuevoTexto].join("\n");

  const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
    [
      { text: "📤 Enviar así", callback_data: `draft_enviar:${borrador.id}` },
      { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` },
    ],
    [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
  ]);

  await actualizarMessageIdBorrador(borrador.id, messageId);
}
