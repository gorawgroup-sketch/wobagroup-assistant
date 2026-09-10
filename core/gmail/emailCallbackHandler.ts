import Anthropic from "@anthropic-ai/sdk";
import { crearMensajeAnthropic } from "../ai/anthropicGateway";
import { crearEjecucionIA } from "../ai/policy";
import { answerCallbackQuery, editTelegramMessage, editTelegramMessageSmart, sendTelegramMessage, sendTelegramMessageSmart, sendTelegramMessageWithButtons } from "../telegram/client";
import { consumirPropuestaAccionCorreo, type PropuestaAccionCorreo } from "./emailActionStore";
import { guardarPendienteOrientacionCorreo } from "./emailOrientationStore";
import { crearBorradorCorreo, actualizarMessageIdBorrador, actualizarCuerpoBorrador, obtenerBorradorCorreo, consumirBorradorCorreo, huboBorradorCreadoDesde } from "./emailDraftStore";
import { guardarPendienteEdicionBorrador } from "./emailDraftEditStore";
import {
  crearOfertaResponderCorreo,
  actualizarMessageIdOfertaResponder,
  consumirOfertaResponderCorreo,
} from "./emailReplyOfferStore";
import { enviarCorreo, obtenerCuerpoCompletoCorreo, extraerDireccionCorreo } from "./client";
import { EnvioCorreoInciertoError } from "./durableSend";
import { askClaude } from "../claude/client";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import type { TelegramCallbackQuery } from "../telegram/types";

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

    const cuerpo = await askClaude(promptBorrador, undefined, undefined, "redactar_borrador_correo");
    const to = extraerDireccionCorreo(de);

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
    if (propuesta.deColaCorreo) await avanzarColaCorreoSiActivo(propuesta.chatId);
    return;
  }

  if (accion === "email_guardar") {
    await answerCallbackQuerySafe(callback.id, "Leyendo el correo...");
    try {
      const cuerpo = await obtenerCuerpoCompletoCorreo(propuesta.mensajeId);
      const contenido = [`De: ${propuesta.de}`, `Asunto: ${propuesta.asunto}`, "", cuerpo].join("\n");
      await editTelegramMessage(propuesta.chatId, propuesta.messageId, "🧠 Guardando como conocimiento — elige la empresa abajo.", []);
      // Pedido explícito de Carlos: revisar_correo_puntual (fuera de la cola) también puede crear
      // PropuestaAccionCorreo — ya no es cierto que "solo se crea desde la cola", así que esto sigue
      // el deColaCorreo real de la propuesta en vez de asumir true.
      await iniciarSeleccionEmpresaCaptura(propuesta.chatId, contenido, propuesta.de, undefined, propuesta.deColaCorreo);
    } catch (error) {
      console.error("[emailCallbackHandler] Error preparando la captura de un correo:", error);
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `⚠️ No pude leer "${propuesta.asunto}" para guardarlo como conocimiento.`,
        []
      );
      if (propuesta.deColaCorreo) await avanzarColaCorreoSiActivo(propuesta.chatId);
    }
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
      deColaCorreo: propuesta.deColaCorreo,
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

    const respuesta = await askClaude(instruccion, propuesta.chatId, undefined, "accion_correo");

    await editTelegramMessageSmart(
      propuesta.chatId,
      propuesta.messageId,
      respuesta,
      [],
      `✅ Procesado — ${propuesta.asunto} (${propuesta.de})`
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
    if (propuesta.deColaCorreo) await avanzarColaCorreoSiActivo(propuesta.chatId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] Error procediendo con la acción:", message);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `⚠️ Error al procesar — ${propuesta.asunto} (${propuesta.de})\n\n${message}`,
      []
    );
    if (propuesta.deColaCorreo) await avanzarColaCorreoSiActivo(propuesta.chatId);
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
  messageIdHeader?: string,
  deColaCorreo = false
): Promise<void> {
  await sendTelegramMessage(chatId, "🔄 Procesando tu instrucción — esto puede tardar uno o dos minutos...").catch(
    (error) => console.error("[emailCallbackHandler] No se pudo mostrar 'Procesando...' (no crítico):", error)
  );

  const instruccion =
    `El usuario dio instrucciones específicas sobre un correo entrante. ` +
    `Correo — De: ${de}. Asunto: ${asunto}. Resumen: ${resumen}. ` +
    `Instrucción del usuario: ${instruccionUsuario}. ` +
    `Investiga y ejecuta lo que corresponda con las herramientas disponibles, y reporta el resultado.`;

  // Bug real encontrado en vivo (2026-09-08, caso DYLO/Alberto Comolli): el chequeo de abajo decidía
  // si generar un SEGUNDO borrador aparte (generarBorradorYOfrecer) mirando si la instrucción del
  // usuario MENCIONA la palabra "correo"/"responder" — "envío correo a Alberto..." la contiene, así
  // que disparaba el segundo borrador SIEMPRE, sin fijarse en si askClaude ya había cumplido el
  // pedido usando proponer_envio_correo (que ya deja su propio borrador real, con sus propios
  // botones). Carlos terminó con dos borradores distintos y contradictorios para la misma
  // instrucción. Ahora se marca el instante ANTES de llamar a askClaude y, después, se revisa el
  // store real de borradores — si askClaude ya creó uno para este chat mientras corría, no hace falta
  // (ni se debe) generar otro.
  const antesDeAskClaude = Date.now();
  const respuesta = await askClaude(instruccion, chatId, undefined, "orientacion_correo");
  await sendTelegramMessageSmart(chatId, respuesta, undefined, `✅ ${asunto} (${de})`);

  const pareceRespuesta = /correo|responder|contestar|email|mail/i.test(instruccionUsuario);
  if (pareceRespuesta) {
    const yaHayBorrador = await huboBorradorCreadoDesde(chatId, antesDeAskClaude).catch((error) => {
      console.error("[emailCallbackHandler] Error revisando si ya hay borrador (se genera uno igual, por seguridad):", error);
      return false;
    });
    if (!yaHayBorrador) {
      await generarBorradorYOfrecer(chatId, de, asunto, threadId, messageIdHeader, respuesta);
    }
  }
  if (deColaCorreo) await avanzarColaCorreoSiActivo(chatId);
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
      `✏️ Ok — dime qué quieres cambiar (ej. "cambia el saludo por Estimado Carlos", "corrige la fecha al 15 de septiembre", "hazlo más corto") y ajusto el borrador — no hace falta que reescribas todo, solo lo que quieres corregir (para: ${borrador.to}).`,
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
      idempotencyKey: `borrador:${borrador.id}`,
      proceso: "borrador_aprobado",
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
    const incierto = error instanceof EnvioCorreoInciertoError;
    await editTelegramMessage(
      borrador.chatId,
      borrador.messageId,
      incierto
        ? `⚠️ Estado de envío incierto para ${borrador.to}. Gmail no confirmó el resultado y Wobi no repetirá el envío para evitar un correo duplicado. El ledger lo verificará contra la carpeta Enviados.`
        : `⚠️ Error al enviar a ${borrador.to}: ${message}\n\nEl borrador se conserva — puedes volver a intentarlo.`,
      incierto
        ? []
        : [
            [
              { text: "📤 Reintentar envío", callback_data: `draft_enviar:${borrador.id}:${Date.now().toString(36)}` },
              { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` },
            ],
            [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
          ]
    );
  }
}

let anthropicEdicion: Anthropic | null = null;
function getClienteEdicion(): Anthropic {
  if (anthropicEdicion) return anthropicEdicion;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
  anthropicEdicion = new Anthropic({ apiKey });
  return anthropicEdicion;
}

/**
 * Aplica una instrucción de edición en lenguaje natural sobre el cuerpo
 * ACTUAL de un borrador de correo, devolviendo el cuerpo completo ya
 * actualizado — nunca reescribe partes que no se pidió tocar, a menos que la
 * instrucción sea ella misma claramente un correo completo de reemplazo.
 */
async function aplicarEdicionBorrador(cuerpoActual: string, instruccion: string): Promise<string> {
  const anthropic = getClienteEdicion();
  const response = await crearMensajeAnthropic(anthropic, crearEjecucionIA("editar_borrador_correo"), {
    model: "claude-sonnet-5",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content:
          `Este es el cuerpo ACTUAL de un borrador de correo:\n\n"""\n${cuerpoActual}\n"""\n\n` +
          `El usuario pidió este cambio: "${instruccion}"\n\n` +
          `Aplica SOLO ese cambio y devuelve el cuerpo COMPLETO del correo ya actualizado, preservando ` +
          `todo lo demás tal cual (mismo tono, mismo formato, mismos datos que no se pidió cambiar) — ` +
          `NUNCA reescribas partes que no se pidió tocar. Si la instrucción es ella misma claramente un ` +
          `correo completo de reemplazo (no una instrucción de edición sobre algo puntual), usa ese texto ` +
          `tal cual como el nuevo cuerpo. Responde ÚNICAMENTE con el texto final del correo — sin comillas, ` +
          `sin explicaciones, sin comentarios tuyos antes o después.`,
      },
    ],
  });

  // Hallazgo real de auditoría: con max_tokens acotado, un borrador largo podría cortarse a mitad de
  // frase sin ningún aviso — un stop_reason distinto de "end_turn" (ej. "max_tokens") significa que el
  // texto está truncado, nunca se debe usar como si fuera el cuerpo final del correo.
  if (response.stop_reason !== "end_turn") {
    throw new Error(`La respuesta quedó incompleta (${response.stop_reason}) — probablemente el correo es muy largo.`);
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const resultado = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  if (!resultado) throw new Error("La IA no devolvió ningún texto.");
  return resultado;
}

/**
 * Continúa el flujo cuando el usuario responde tras pulsar "✏️ Editar antes
 * de enviar". Pedido explícito de Carlos: antes, esta función tomaba el
 * mensaje del usuario como el CUERPO COMPLETO nuevo, descartando el borrador
 * propuesto entero — si Carlos solo quería corregir una palabra o una frase,
 * tenía que reescribir todo el correo él mismo. Ahora la respuesta se trata
 * como una INSTRUCCIÓN de edición (aplicarEdicionBorrador, abajo) sobre el
 * borrador YA existente — Claude aplica solo el cambio pedido y devuelve el
 * cuerpo completo actualizado, preservando el resto tal cual.
 */
export async function continuarConEdicionBorrador(chatId: number, borradorId: string, instruccion: string): Promise<void> {
  const borradorActual = await obtenerBorradorCorreo(borradorId);
  if (!borradorActual) {
    await sendTelegramMessage(chatId, "Ese borrador ya no está disponible.");
    return;
  }

  // Hallazgo real de auditoría: antes esta escritura era instantánea (guardar texto tal cual); ahora
  // implica una llamada de red real a Anthropic — mismo patrón ya establecido en este archivo para
  // operaciones largas (ver continuarConOrientacion, más arriba) para que Carlos no se quede sin
  // ninguna señal mientras espera.
  await sendTelegramMessage(chatId, "🔄 Ajustando el borrador...").catch((error) =>
    console.error("[emailCallbackHandler] No se pudo mostrar 'Ajustando...' (no crítico):", error)
  );

  // Hallazgo real de auditoría: todo lo que sigue (incluidas las llamadas a Sheets/Telegram, antes sin
  // proteger) puede fallar por red/cuota — sin este try/catch, Carlos se quedaba sin ningún botón para
  // reintentar (el pendiente de edición ya se consumió en server.ts antes de llegar acá). Cualquier
  // fallo de acá en adelante re-ofrece el mismo botón de editar en vez de dejar el flujo colgado.
  try {
    const cuerpoActualizado = await aplicarEdicionBorrador(borradorActual.cuerpo, instruccion);

    const borrador = await actualizarCuerpoBorrador(borradorId, cuerpoActualizado);
    if (!borrador) {
      await sendTelegramMessage(chatId, "Ese borrador ya no está disponible.");
      return;
    }

    const texto = [`✉️ Borrador actualizado — para ${borrador.to}:`, "", cuerpoActualizado].join("\n");

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
    console.error("[emailCallbackHandler] Error aplicando la edición del borrador:", message);
    await sendTelegramMessageWithButtons(chatId, `⚠️ No pude aplicar ese cambio (${message}). El borrador se conserva tal cual — inténtalo de nuevo.`, [
      [{ text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borradorId}` }],
    ]);
  }
}
