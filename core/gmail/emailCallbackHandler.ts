import { retirarPreguntaCaducada } from "../telegram/preguntaCaducada";
import Anthropic from "@anthropic-ai/sdk";
import { crearMensajeAnthropic } from "../ai/anthropicGateway";
import { crearEjecucionIA } from "../ai/policy";
import { answerCallbackQuery, editTelegramMessage, editTelegramMessageSmart, sendTelegramMessage, sendTelegramMessageSmart, sendTelegramMessageWithButtons, sendTelegramTemporaryNotice } from "../telegram/client";
import {
  consumirPropuestaAccionCorreo,
  restaurarPropuestaAccionCorreo,
  type PropuestaAccionCorreo,
} from "./emailActionStore";
import { guardarPendienteOrientacionCorreo } from "./emailOrientationStore";
import {
  crearBorradorCorreo,
  actualizarMessageIdBorrador,
  actualizarCuerpoBorrador,
  obtenerBorradorCorreo,
  consumirBorradorCorreo,
  obtenerBorradorCreadoDesde,
  vincularBorradorACola,
  type BorradorCorreo,
} from "./emailDraftStore";
import { guardarPendienteEdicionBorrador } from "./emailDraftEditStore";
import {
  crearOfertaResponderCorreo,
  actualizarMessageIdOfertaResponder,
  consumirOfertaResponderCorreo,
  restaurarOfertaResponderCorreo,
  obtenerOfertaResponderCorreo,
  obtenerOfertaResponderPorCorreo,
  identidadCorreoDeOferta,
  type OfertaResponderCorreo,
} from "./emailReplyOfferStore";
import { consultarEnvioCorreoExistente, enviarCorreo, obtenerCuerpoCompletoCorreo, extraerDireccionCorreo } from "./client";
import { EnvioCorreoInciertoError } from "./durableSend";
import { askClaude } from "../claude/client";
import { ErrorTrasEjecucion, esErrorTrasEjecucion } from "../utils/errorTrasEjecucion";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import type { InlineKeyboardButton, TelegramCallbackQuery } from "../telegram/types";
import {
  incrementarPendientesActivo,
  revertirIncrementoPendientesActivo,
  type IdentidadCorreoCola,
} from "./colaRevisionStore";
import { conMutex } from "../utils/asyncMutex";
import { registrarInstruccionCorreoAprendida } from "./instruccionesAprendidasStore";

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
  contextoInvestigacion: string,
  origenCola?: IdentidadCorreoCola
): Promise<boolean> {
  let borradorCreado: BorradorCorreo | undefined;
  let telegramMessageId: number | undefined;
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
      deColaCorreo: Boolean(origenCola),
      correoThreadId: origenCola?.threadId,
      correoMensajeId: origenCola?.mensajeId,
    });
    borradorCreado = borrador;

    const texto = [`✉️ Borrador de respuesta a ${to}:`, "", cuerpo].join("\n");

    telegramMessageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "📤 Enviar así", callback_data: `draft_enviar:${borrador.id}` },
        { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` },
      ],
      [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
    ]);

    await actualizarMessageIdBorrador(borrador.id, telegramMessageId);
    const confirmado = await obtenerBorradorCorreo(borrador.id);
    if (!confirmado || confirmado.messageId !== telegramMessageId) {
      throw new Error("El borrador se mostró, pero su entrega no quedó confirmada en el estado durable.");
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] Error generando borrador de respuesta:", message);
    if (borradorCreado) {
      await consumirBorradorCorreo(borradorCreado.id).catch((errorLimpieza) =>
        console.error("[emailCallbackHandler] No se pudo retirar el borrador incompleto:", errorLimpieza)
      );
    }
    if (telegramMessageId) {
      await editTelegramMessage(
        chatId,
        telegramMessageId,
        "⚠️ Este borrador no quedó guardado de forma segura y sus botones fueron desactivados. Vuelve a iniciar la acción para reintentarlo.",
        []
      ).catch((errorEdicion) =>
        console.error("[emailCallbackHandler] No se pudo desactivar el borrador sin entrega confirmada:", errorEdicion)
      );
    }
    await sendTelegramMessage(chatId, `⚠️ No se pudo generar el borrador de respuesta: ${message}`).catch(() => {});
    return false;
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
  contexto: string,
  origenCola?: IdentidadCorreoCola | null
): Promise<boolean> {
  const threadNormalizado = threadId?.trim() || "sin-hilo";
  return conMutex(`emailReplyOffer:publicar:${chatId}:${threadNormalizado}`, async () => {
    let identidadExacta: Required<IdentidadCorreoCola> | undefined;
    if (origenCola) {
      const threadCorreo = origenCola.threadId?.trim();
      const mensajeCorreo = origenCola.mensajeId?.trim();
      if (!threadCorreo || !mensajeCorreo) {
        console.error("[emailCallbackHandler] Se rechazó una oferta de cola sin identidad exacta.");
        return false;
      }
      identidadExacta = { threadId: threadCorreo, mensajeId: mensajeCorreo };
    }

    try {
      if (identidadExacta) {
        const ofertaExistente = await obtenerOfertaResponderPorCorreo(chatId, identidadExacta);
        // Una fila messageId=0 es solo una reserva provisional. No confirma
        // que el operador haya recibido la pregunta ni debe cortar el retry.
        if (ofertaExistente) return ofertaExistente.messageId > 0;

        // Si la oferta ya transfirió su unidad a un borrador, un segundo toque
        // del botón del documento no crea otra pregunta ni otro contador.
        try {
          const borradorExistente = await obtenerBorradorCreadoDesde(chatId, 0, {
            threadId: identidadExacta.threadId,
            to: extraerDireccionCorreo(de),
          });
          if (
            borradorExistente?.deColaCorreo &&
            borradorExistente.correoThreadId === identidadExacta.threadId &&
            borradorExistente.correoMensajeId === identidadExacta.mensajeId
          ) {
            return borradorExistente.messageId > 0;
          }
        } catch (error) {
          // Varios borradores correlacionados requieren revisión; crear otro
          // empeoraría la ambigüedad y sumaría una unidad imposible de seguir.
          console.error("[emailCallbackHandler] No se publicó otra oferta porque ya hay borradores correlacionados:", error);
          return false;
        }
      }

      let contadorReservado = false;
      let oferta: OfertaResponderCorreo | undefined;
      let entregaConfirmada = false;
      let messageIdPublicado: number | undefined;
      try {
        if (identidadExacta) {
          contadorReservado = await incrementarPendientesActivo(chatId, identidadExacta);
          if (!contadorReservado) {
            console.error("[emailCallbackHandler] El correo dejó de ser el activo antes de reservar la oferta de respuesta.");
            return false;
          }
        }

        oferta = await crearOfertaResponderCorreo({
          chatId,
          messageId: 0,
          de,
          asunto,
          threadId,
          messageIdHeader,
          contexto,
          deColaCorreo: Boolean(identidadExacta),
          correoThreadId: identidadExacta?.threadId,
          correoMensajeId: identidadExacta?.mensajeId,
        });

        messageIdPublicado = await sendTelegramMessageWithButtons(
          chatId,
          `✉️ ¿Quieres que responda el correo "${asunto}" de ${de}?`,
          [[
            { text: "✅ Sí, responder", callback_data: `email_responder_si:${oferta.id}` },
            { text: "❌ No", callback_data: `email_responder_no:${oferta.id}` },
          ]]
        );
        await actualizarMessageIdOfertaResponder(oferta.id, messageIdPublicado);
        const confirmada = await obtenerOfertaResponderCorreo(oferta.id);
        if (!confirmada || confirmada.messageId !== messageIdPublicado) {
          throw new Error("La pregunta se mostró, pero su entrega no quedó confirmada en el estado durable.");
        }
        entregaConfirmada = true;
        return true;
      } catch (error) {
        let ofertaRetirada = !oferta;
        if (oferta && !entregaConfirmada) {
          try {
            const retirada = await consumirOfertaResponderCorreo(oferta.id);
            ofertaRetirada = Boolean(retirada) || !(await obtenerOfertaResponderCorreo(oferta.id));
          } catch (errorLimpieza) {
            console.error("[emailCallbackHandler] No se pudo retirar la oferta sin entrega confirmada:", errorLimpieza);
          }
        }
        if (contadorReservado && !entregaConfirmada && identidadExacta && ofertaRetirada) {
          await revertirIncrementoPendientesActivo(chatId, identidadExacta).catch((errorCompensando) =>
            console.error("[emailCallbackHandler] No se pudo compensar la reserva de la oferta fallida:", errorCompensando)
          );
        }
        if (messageIdPublicado && !entregaConfirmada) {
          await editTelegramMessage(
            chatId,
            messageIdPublicado,
            "⚠️ Esta pregunta no quedó guardada de forma segura y sus botones fueron desactivados. La revisión puede volver a intentarla.",
            []
          ).catch((errorEdicion) =>
            console.error("[emailCallbackHandler] No se pudo desactivar la oferta sin entrega confirmada:", errorEdicion)
          );
        }
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[emailCallbackHandler] Error ofreciendo responder el correo:", message);
      return false;
    }
  });
}

function tecladoOfertaResponder(oferta: OfertaResponderCorreo): InlineKeyboardButton[][] {
  return [[
    { text: "✅ Sí, responder", callback_data: `email_responder_si:${oferta.id}` },
    { text: "❌ No", callback_data: `email_responder_no:${oferta.id}` },
  ]];
}

async function restaurarOfertaTrasError(
  oferta: OfertaResponderCorreo,
  callback: TelegramCallbackQuery,
  detalle: string
): Promise<void> {
  const messageId = oferta.messageId || callback.message?.message_id || 0;
  const restaurada = { ...oferta, messageId };
  await restaurarOfertaResponderCorreo(restaurada);
  const texto = `${detalle}\n\nEl correo sigue pendiente y sin marcar como leído.`;
  if (messageId) {
    await editTelegramMessage(oferta.chatId, messageId, texto, tecladoOfertaResponder(restaurada)).catch(() => {});
  } else {
    await sendTelegramMessageWithButtons(oferta.chatId, texto, tecladoOfertaResponder(restaurada)).catch(() => {});
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

const ACCIONES_PROPUESTA_CORREO = new Set(["email_descartar", "email_guardar", "email_orientar", "email_proceder"]);

export function identidadCorreoDePropuesta(
  propuesta: Pick<PropuestaAccionCorreo, "threadId" | "mensajeId">
): Required<IdentidadCorreoCola> | undefined {
  const threadId = propuesta.threadId?.trim() || undefined;
  const mensajeId = propuesta.mensajeId?.trim() || undefined;
  return threadId && mensajeId ? { threadId, mensajeId } : undefined;
}

export function identidadCorreoDeBorrador(
  borrador: Pick<BorradorCorreo, "correoThreadId" | "correoMensajeId">
): Required<IdentidadCorreoCola> | undefined {
  const threadId = borrador.correoThreadId?.trim() || undefined;
  const mensajeId = borrador.correoMensajeId?.trim() || undefined;
  return threadId && mensajeId ? { threadId, mensajeId } : undefined;
}

function tecladoPropuestaCorreo(propuesta: PropuestaAccionCorreo, yaEjecutada = false): InlineKeyboardButton[][] {
  return [
    [
      // Tras una ejecución ya iniciada, "Proceder" repetiría la acción: se retira (ver core/utils/errorTrasEjecucion.ts).
      ...(yaEjecutada ? [] : [{ text: "✅ Proceder", callback_data: `email_proceder:${propuesta.id}` }]),
      { text: "🧠 Guardar como conocimiento", callback_data: `email_guardar:${propuesta.id}` },
    ],
    [
      { text: "❌ Descartar", callback_data: `email_descartar:${propuesta.id}` },
      { text: "✏️ Dar instrucciones específicas", callback_data: `email_orientar:${propuesta.id}` },
    ],
  ];
}

async function restaurarPropuestaTrasError(
  propuesta: PropuestaAccionCorreo,
  detalle: string,
  yaEjecutada = false
): Promise<void> {
  try {
    await restaurarPropuestaAccionCorreo(propuesta);
  } catch (errorRestaurando) {
    console.error("[emailCallbackHandler] No se pudo restaurar la propuesta tras el fallo:", errorRestaurando);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `${detalle}\n\nNo pude restaurar los botones automáticamente. El correo permanece sin leer; vuelve a iniciar su revisión.`,
      []
    ).catch(() => {});
    return;
  }

  const texto = yaEjecutada
    ? `${detalle}\n\nLa acción YA se ejecutó (total o parcialmente) — revisa arriba lo que quedó hecho. ` +
      "Quité «Proceder» para que no se repita; el correo sigue sin leer: ciérralo con «Descartar» cuando lo compruebes."
    : `${detalle}\n\nEl correo sigue pendiente y sin marcar como leído. Puedes reintentar con los mismos botones.`;
  const teclado = tecladoPropuestaCorreo(propuesta, yaEjecutada);
  try {
    await editTelegramMessage(propuesta.chatId, propuesta.messageId, texto, teclado);
  } catch (errorEditando) {
    console.error("[emailCallbackHandler] No se pudo restaurar el mensaje original; se publica un reintento nuevo:", errorEditando);
    await sendTelegramMessageWithButtons(propuesta.chatId, texto, teclado).catch(() => {});
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
  const [accion, id] = callback.data?.split(":") ?? [];
  if ((accion === "email_responder_si" || accion === "email_responder_no") && id) {
    return conMutex(`emailReplyOffer:callback:${id}`, async () => {
      const oferta = await obtenerOfertaResponderCorreo(id);
      if (!oferta) return handleEmailActionCallbackInterno(callback);
      const threadNormalizado = oferta.threadId?.trim() || "sin-hilo";
      // La transición oferta→borrador comparte el mismo cerrojo que la
      // publicación/deduplicación. Así un segundo botón lateral no puede
      // colarse justo entre consumir la oferta y persistir el borrador.
      return conMutex(
        `emailReplyOffer:publicar:${oferta.chatId}:${threadNormalizado}`,
        () => handleEmailActionCallbackInterno(callback)
      );
    });
  }
  return handleEmailActionCallbackInterno(callback);
}

async function handleEmailActionCallbackInterno(callback: TelegramCallbackQuery): Promise<void> {
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
      await retirarPreguntaCaducada(callback, "Esta pregunta ya no está disponible.");
      return;
    }

    const identidadOferta = identidadCorreoDeOferta(oferta);
    if (oferta.deColaCorreo && !identidadOferta) {
      await answerCallbackQuerySafe(callback.id, "No pude verificar a qué correo pertenece esta pregunta.");
      await restaurarOfertaTrasError(
        oferta,
        callback,
        "⚠️ La pregunta perdió la identidad exacta del correo y no se ejecutó por seguridad."
      );
      return;
    }

    const messageIdOferta = oferta.messageId || callback.message?.message_id || 0;

    if (accion === "email_responder_no") {
      await answerCallbackQuerySafe(callback.id, "Ok.");
      if (messageIdOferta) {
        await editTelegramMessage(oferta.chatId, messageIdOferta, `Ok — no respondo el correo "${oferta.asunto}".`, []).catch(
          (error) => console.error("[emailCallbackHandler] No se pudo reflejar 'No responder' en Telegram (no crítico):", error)
        );
      }
      if (oferta.deColaCorreo && identidadOferta) {
        await avanzarColaCorreoSiActivo(
          oferta.chatId,
          identidadOferta,
          `email-oferta:${oferta.id}:resolver`
        );
      }
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Redactando...");
    if (messageIdOferta) {
      await editTelegramMessage(oferta.chatId, messageIdOferta, `🔄 Redactando respuesta para "${oferta.asunto}"...`, []).catch(() => {});
    }
    const borradorPreparado = await generarBorradorYOfrecer(
      oferta.chatId,
      oferta.de,
      oferta.asunto,
      oferta.threadId,
      oferta.messageIdHeader,
      oferta.contexto,
      oferta.deColaCorreo ? identidadOferta : undefined
    );
    if (!borradorPreparado) {
      await restaurarOfertaTrasError(
        { ...oferta, messageId: messageIdOferta },
        callback,
        `⚠️ No pude preparar la respuesta para "${oferta.asunto}". Puedes reintentar o elegir No.`
      );
    }
    return;
  }

  if (!ACCIONES_PROPUESTA_CORREO.has(accion)) {
    await answerCallbackQuerySafe(callback.id, "Acción de correo no válida.");
    return;
  }

  const propuesta = await consumirPropuestaAccionCorreo(id);

  if (!propuesta) {
    await retirarPreguntaCaducada(callback, "Esta propuesta ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  const identidadPropuesta = identidadCorreoDePropuesta(propuesta);
  if (propuesta.deColaCorreo && !identidadPropuesta) {
    await answerCallbackQuerySafe(callback.id, "No pude verificar a qué correo pertenece esta acción.");
    await restaurarPropuestaTrasError(
      propuesta,
      "⚠️ La acción no conserva la identidad del correo original y no se ejecutó por seguridad."
    );
    return;
  }

  if (accion === "email_descartar") {
    await answerCallbackQuerySafe(callback.id, "Descartado.");
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `❌ Descartado — ${propuesta.asunto} (${propuesta.de})`,
      []
    ).catch((error) => console.error("[emailCallbackHandler] No se pudo reflejar el descarte en Telegram (no crítico):", error));
    if (propuesta.deColaCorreo && identidadPropuesta) {
      await avanzarColaCorreoSiActivo(
        propuesta.chatId,
        identidadPropuesta,
        `email-accion:${propuesta.id}:resolver`
      );
    }
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
      await iniciarSeleccionEmpresaCaptura(
        propuesta.chatId,
        contenido,
        propuesta.de,
        undefined,
        propuesta.deColaCorreo,
        identidadPropuesta
      );
    } catch (error) {
      console.error("[emailCallbackHandler] Error preparando la captura de un correo:", error);
      await restaurarPropuestaTrasError(
        propuesta,
        `⚠️ No pude leer "${propuesta.asunto}" para guardarlo como conocimiento.`
      );
    }
    return;
  }

  if (accion === "email_orientar") {
    await answerCallbackQuerySafe(callback.id);
    try {
      await guardarPendienteOrientacionCorreo({
        chatId: propuesta.chatId,
        messageId: propuesta.messageId,
        de: propuesta.de,
        asunto: propuesta.asunto,
        resumen: propuesta.resumen,
        threadId: propuesta.threadId,
        messageIdHeader: propuesta.messageIdHeader,
        deColaCorreo: propuesta.deColaCorreo,
        mensajeId: propuesta.mensajeId,
      });
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `✏️ Ok — respóndeme qué quieres que haga con este correo ("${propuesta.asunto}", de ${propuesta.de}).`,
        []
      ).catch((error) => console.error("[emailCallbackHandler] No se pudo mostrar la solicitud de orientación (no crítico):", error));
    } catch (error) {
      console.error("[emailCallbackHandler] Error guardando la orientación pendiente:", error);
      await restaurarPropuestaTrasError(
        propuesta,
        `⚠️ No pude preparar la orientación para "${propuesta.asunto}".`
      );
    }
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

  // Tras askClaude la acción ya produjo efectos: un fallo posterior no debe ofrecer "Proceder" otra vez.
  // Si askClaude falla a mitad tras iniciar una herramienta con efectos, lanza TurnoConEfectosError
  // (core/claude/turnSafety.ts), que esErrorTrasEjecucion también reconoce; un fallo previo sí es reintentable.
  let accionEjecutada = false;
  try {
    const identidad = identidadPropuesta;
    const requiereRespuesta = propuesta.tipo === "necesita_respuesta" || propuesta.tipo === "instruccion_jefe";
    const instruccion =
      `Se aprobó proceder con esta acción propuesta a partir de un correo entrante. ` +
      `Correo — De: ${propuesta.de}. Asunto: ${propuesta.asunto}. Resumen: ${propuesta.resumen}. ` +
      `Acción a realizar: ${propuesta.accionSugerida}. ` +
      `Investiga y ejecuta lo que corresponda con las herramientas disponibles, y reporta el resultado. ` +
      (requiereRespuesta
        ? `Si propones una respuesta, usa destinatario ${extraerDireccionCorreo(propuesta.de)}, ` +
          `thread_id ${propuesta.threadId} y message_id_header ${propuesta.messageIdHeader}.`
        : "");

    const antesDeAskClaude = Date.now();
    const respuesta = await askClaude(instruccion, propuesta.chatId, undefined, "accion_correo");
    accionEjecutada = true;

    await editTelegramMessageSmart(
      propuesta.chatId,
      propuesta.messageId,
      respuesta,
      [],
      `✅ Procesado — ${propuesta.asunto} (${propuesta.de})`
    );

    // askClaude puede haber usado proponer_envio_correo y dejado ya un
    // borrador con botones. Ese borrador es un estado intermedio: hereda la
    // identidad y recién Enviar/Cancelar cerrará el correo.
    let borradorPendiente = await obtenerBorradorCreadoDesde(
      propuesta.chatId,
      antesDeAskClaude,
      propuesta.deColaCorreo || requiereRespuesta
        ? {
            threadId: propuesta.threadId,
            messageIdHeader: propuesta.messageIdHeader,
            to: extraerDireccionCorreo(propuesta.de),
            // Si hace falta responder al remitente, un borrador a terceros del hilo no lo sustituye.
            aceptarOtroDestinatarioDelHilo: !requiereRespuesta,
          }
        : undefined
    );
    if (borradorPendiente && propuesta.deColaCorreo && identidad) {
      borradorPendiente = await vincularBorradorACola(borradorPendiente.id, identidad);
      if (!borradorPendiente) throw new Error("No se pudo vincular el borrador al correo original.");
    }
    let hayBorradorPendiente = Boolean(borradorPendiente);

    if (!hayBorradorPendiente && requiereRespuesta) {
      const borradorPreparado = await generarBorradorYOfrecer(
        propuesta.chatId,
        propuesta.de,
        propuesta.asunto,
        propuesta.threadId,
        propuesta.messageIdHeader,
        respuesta,
        propuesta.deColaCorreo ? identidad : undefined
      );
      if (!borradorPreparado) throw new Error("No se pudo preparar el borrador de respuesta requerido.");
      hayBorradorPendiente = true;
    }
    if (!hayBorradorPendiente && propuesta.deColaCorreo && identidad) {
      await avanzarColaCorreoSiActivo(
        propuesta.chatId,
        identidad,
        `email-accion:${propuesta.id}:resolver`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[emailCallbackHandler] Error procediendo con la acción:", message);
    await restaurarPropuestaTrasError(
      propuesta,
      `⚠️ Error al procesar — ${propuesta.asunto} (${propuesta.de})\n\n${message}`,
      accionEjecutada || esErrorTrasEjecucion(error)
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
  messageIdHeader?: string,
  deColaCorreo = false,
  mensajeId?: string
): Promise<void> {
  await sendTelegramMessage(chatId, "🔄 Procesando tu instrucción — esto puede tardar uno o dos minutos...").catch(
    (error) => console.error("[emailCallbackHandler] No se pudo mostrar 'Procesando...' (no crítico):", error)
  );

  const instruccion =
    `El usuario dio instrucciones específicas sobre un correo entrante. ` +
    `Correo — De: ${de}. Asunto: ${asunto}. Resumen: ${resumen}. ` +
    `Instrucción del usuario: ${instruccionUsuario}. ` +
    `Investiga y ejecuta lo que corresponda con las herramientas disponibles, y reporta el resultado. ` +
    (/correo|responder|contestar|email|mail/i.test(instruccionUsuario)
      ? `Si propones una respuesta, usa destinatario ${extraerDireccionCorreo(de)}, ` +
        `thread_id ${threadId ?? ""} y message_id_header ${messageIdHeader ?? ""}.`
      : "");

  const identidad = identidadCorreoDePropuesta({ threadId: threadId ?? "", mensajeId: mensajeId ?? "" });
  if (deColaCorreo && !identidad) {
    throw new Error("La orientación perdió la identidad del correo original; se conserva para revisión segura.");
  }

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

  // Desde aquí la instrucción YA produjo efectos (askClaude pudo crear borradores, recordatorios,
  // capturas...). Cualquier fallo del cierre se reporta como ErrorTrasEjecucion: el servidor nunca
  // vuelve a armar la orientación para repetirla (ver core/utils/errorTrasEjecucion.ts).
  try {
    // La memoria operativa solo acepta indicaciones explícitamente reutilizables
    // ("siempre", "cada vez", "de ahora en adelante", etc.). Una orden puntual
    // sigue siendo puntual. Este registro es auxiliar: si Sheets falla, nunca
    // bloquea ni cambia el resultado de la operación que el usuario acaba de pedir.
    const aprendizaje = await registrarInstruccionCorreoAprendida({
      de,
      asunto,
      instruccion: instruccionUsuario,
      mensajeIdOrigen: mensajeId,
    }).catch((error) => {
      console.error("[emailCallbackHandler] No se pudo guardar la instrucción reutilizable (no crítico):", error);
      return { guardada: false, reemplazo: false };
    });

    await sendTelegramMessageSmart(chatId, respuesta, undefined, `✅ ${asunto} (${de})`);
    if (aprendizaje.guardada) {
      const detalle = aprendizaje.reemplazo
        ? " La regla anterior para este mismo remitente y tipo de correo quedó desactivada."
        : "";
      await sendTelegramMessage(
        chatId,
        `🧠 Instrucción guardada para futuros correos del mismo alcance.${detalle}`
      ).catch((error) =>
        console.error("[emailCallbackHandler] No se pudo confirmar la memoria de instrucción (no crítico):", error)
      );
    }

    const pareceRespuesta = /correo|responder|contestar|email|mail/i.test(instruccionUsuario);
    let borradorPendiente = await obtenerBorradorCreadoDesde(
      chatId,
      antesDeAskClaude,
      deColaCorreo || pareceRespuesta
        ? {
            threadId,
            messageIdHeader,
            to: extraerDireccionCorreo(de),
            // La orientación la escribe Carlos: si pidió escribir a otros en este hilo, ESE es el borrador.
            aceptarOtroDestinatarioDelHilo: true,
          }
        : undefined
    );
    if (borradorPendiente && deColaCorreo && identidad) {
      borradorPendiente = await vincularBorradorACola(borradorPendiente.id, identidad);
      if (!borradorPendiente) throw new Error("No se pudo vincular el borrador al correo original.");
    }

    if (!borradorPendiente && pareceRespuesta) {
      const borradorPreparado = await generarBorradorYOfrecer(
        chatId,
        de,
        asunto,
        threadId,
        messageIdHeader,
        respuesta,
        deColaCorreo ? identidad : undefined
      );
      if (!borradorPreparado) throw new Error("No se pudo preparar el borrador solicitado.");
      return;
    }
    if (!borradorPendiente && deColaCorreo && identidad) {
      const identidadEstable = `${identidad.threadId ?? ""}:${identidad.mensajeId ?? ""}`;
      await avanzarColaCorreoSiActivo(
        chatId,
        identidad,
        `email-orientacion:${identidadEstable}:resolver`
      );
    }
  } catch (error) {
    throw new ErrorTrasEjecucion("La instrucción se ejecutó, pero no pude cerrar el correo en la cola", error);
  }
}

/**
 * Maneja los botones de un borrador de respuesta (draft_enviar / draft_editar
 * / draft_cancelar). Solo "draft_enviar" dispara el envío real por Gmail —
 * es el único punto de todo el sistema donde se manda un correo de verdad.
 */
export async function handleDraftCallback(callback: TelegramCallbackQuery): Promise<void> {
  const id = callback.data?.split(":")[1];
  if (!id) return handleDraftCallbackInterno(callback);
  return conMutex(`emailDraftCallback:${id}`, () => handleDraftCallbackInterno(callback));
}

async function handleDraftCallbackInterno(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");

  if (accion === "draft_verificar") {
    const borrador = await obtenerBorradorCorreo(id);
    if (!borrador) {
      await retirarPreguntaCaducada(callback, "Este borrador ya no está pendiente.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Verificando en Gmail...");
    const botonesVerificacion: InlineKeyboardButton[][] = [[
      { text: "🔎 Verificar estado", callback_data: `draft_verificar:${borrador.id}:${Date.now().toString(36)}` },
    ]];
    try {
      const verificado = await consultarEnvioCorreoExistente(`borrador:${borrador.id}`);
      if (!verificado) {
        await editTelegramMessage(
          borrador.chatId,
          borrador.messageId,
          `⚠️ Gmail todavía no tiene un resultado verificable para ${borrador.to}. No reenvié nada; el borrador sigue pendiente.`,
          botonesVerificacion
        );
        return;
      }

      const consumido = await consumirBorradorCorreo(borrador.id);
      if (!consumido) return;
      await editTelegramMessage(
        consumido.chatId,
        consumido.messageId,
        `📤 Envío verificado en Gmail para ${consumido.to}.`,
        []
      ).catch((error) => console.error("[emailCallbackHandler] No se pudo reflejar la verificación en Telegram (no crítico):", error));
      const identidad = identidadCorreoDeBorrador(consumido);
      if (consumido.deColaCorreo && identidad) {
        await avanzarColaCorreoSiActivo(
          consumido.chatId,
          identidad,
          `email-borrador:${consumido.id}:resolver`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await editTelegramMessage(
        borrador.chatId,
        borrador.messageId,
        `⚠️ El envío a ${borrador.to} sigue sin confirmación. No reenvié nada. Puedes volver a verificar más tarde.\n\n${message}`,
        botonesVerificacion
      ).catch(() => {});
    }
    return;
  }

  if (accion === "draft_cancelar") {
    const borrador = await consumirBorradorCorreo(id);
    await answerCallbackQuerySafe(callback.id, "No enviado.");
    if (borrador) {
      await editTelegramMessage(
        borrador.chatId,
        borrador.messageId,
        `❌ No enviado — borrador descartado (para: ${borrador.to}).`,
        []
      ).catch((error) => console.error("[emailCallbackHandler] No se pudo reflejar la cancelación del borrador (no crítico):", error));
      const identidad = identidadCorreoDeBorrador(borrador);
      if (borrador.deColaCorreo && identidad) {
        await avanzarColaCorreoSiActivo(
          borrador.chatId,
          identidad,
          `email-borrador:${borrador.id}:resolver`
        );
      }
    }
    return;
  }

  if (accion === "draft_editar") {
    const borrador = await obtenerBorradorCorreo(id);
    if (!borrador) {
      await retirarPreguntaCaducada(callback, "Este borrador ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id);
    // El siguiente estado se persiste antes de retirar los botones. Si
    // Telegram falla al editar el mensaje, la instruccion de texto no se
    // pierde y el boton original sigue disponible para reintentar.
    await guardarPendienteEdicionBorrador(borrador.chatId, borrador.id);
    await editTelegramMessage(
      borrador.chatId,
      borrador.messageId,
      `✏️ Ok — dime qué quieres cambiar (ej. "cambia el saludo por Estimado Carlos", "corrige la fecha al 15 de septiembre", "hazlo más corto") y ajusto el borrador — no hace falta que reescribas todo, solo lo que quieres corregir (para: ${borrador.to}).`,
      []
    );
    return;
  }

  // draft_enviar
  const borrador = await obtenerBorradorCorreo(id);
  if (!borrador) {
    await retirarPreguntaCaducada(callback, "Este borrador ya no está disponible.");
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
    const consumido = await consumirBorradorCorreo(id);
    if (!consumido) return;

    await editTelegramMessage(consumido.chatId, consumido.messageId, `📤 Enviado a ${consumido.to}.`, []).catch(
      (error) => console.error("[emailCallbackHandler] No se pudo reflejar el envío en Telegram (no crítico):", error)
    );
    const identidad = identidadCorreoDeBorrador(consumido);
    if (consumido.deColaCorreo && identidad) {
      await avanzarColaCorreoSiActivo(
        consumido.chatId,
        identidad,
        `email-borrador:${consumido.id}:resolver`
      );
    }
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
        ? [[{ text: "🔎 Verificar estado", callback_data: `draft_verificar:${borrador.id}:${Date.now().toString(36)}` }]]
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
    await sendTelegramTemporaryNotice(chatId, "Ese borrador ya no está disponible.");
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
      await sendTelegramTemporaryNotice(chatId, "Ese borrador ya no está disponible.");
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
