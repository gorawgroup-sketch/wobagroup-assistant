import { listarContactosAutorespuesta } from "../gmail/autorespuestaContactoStore";
import { listarHilosNoLeidosDe, obtenerHiloCompleto, marcarHiloComoLeido, enviarCorreo } from "../gmail/client";
import { obtenerEstadoHiloAutorespuesta, crearPendienteAprobacionHilo } from "../gmail/hiloAutorespuestaStore";
import { responderCorreoAutomatico } from "../claude/client";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";

/**
 * Pequeña, discreta y aparte del cuerpo redactado por Claude — pedido
 * explícito de Carlos: "una leyenda al final del correo diciendo esto
 * respuesta automática, pequeña bonita y bien diseñada". Reemplaza (no se
 * suma a) la firma personal de Carlos en Gmail — mandarla implicaría que él
 * escribió esto a mano, exactamente lo contrario de lo que la leyenda debe
 * transmitir.
 */
const FOOTER_RESPUESTA_AUTOMATICA =
  '<div style="margin-top:20px;padding-top:10px;border-top:1px solid #e5e7eb;' +
  'font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;color:#9aa0a6;">' +
  "🤖 Respuesta generada y enviada automáticamente por Wobi, el asistente de WOBA Group." +
  "</div>";

/**
 * Redacta y ENVÍA la respuesta de un hilo YA aprobado (ver hiloAutorespuestaStore.ts) — expuesta
 * aparte de revisarConversacionesAutomaticas para que el botón "✅ Sí, automática"
 * (autorespuestaHiloCallbackHandler.ts) pueda responder de inmediato al aprobar, en vez de que
 * Carlos tenga que esperar hasta 15 minutos a la próxima corrida del job.
 */
export async function procesarHiloAutorespuestaAprobado(threadId: string, chatId: number): Promise<boolean> {
  const hilo = await obtenerHiloCompleto(threadId);
  if (!hilo.ultimoMensajeId) return false;

  // El último mensaje del hilo es NUESTRO (ya respondimos y la otra persona no ha vuelto a
  // escribir) — nada nuevo que responder, evita un bucle de "responder a mi propia respuesta".
  const ultimoMensaje = hilo.mensajes[hilo.mensajes.length - 1];
  if (!ultimoMensaje || ultimoMensaje.esNuestro) return false;

  const hiloTexto = hilo.mensajes
    .map((m) => `[${m.esNuestro ? "Wobi (nosotros)" : m.de}] — ${m.fecha}:\n${m.cuerpo}`)
    .join("\n\n---\n\n");

  const respuesta = await responderCorreoAutomatico({
    remitente: hilo.ultimoDe,
    asunto: hilo.asunto,
    hiloTexto,
  });

  if (!respuesta.trim()) {
    console.error(`[revisarConversacionesAutomaticas] Respuesta vacía para el hilo ${threadId} — se salta, se reintenta en la próxima corrida.`);
    return false;
  }

  await enviarCorreo({
    to: hilo.ultimoDe,
    asunto: hilo.asunto || "(sin asunto)",
    cuerpo: respuesta,
    threadId,
    messageIdHeader: hilo.ultimoMessageIdHeader,
    firmaOverride: FOOTER_RESPUESTA_AUTOMATICA,
  });

  await marcarHiloComoLeido(threadId);

  await sendTelegramMessage(
    chatId,
    `🤖 Conversación automática — respondí a ${hilo.ultimoDe} ("${hilo.asunto}"):\n\n${respuesta}`
  ).catch((error) => console.error("[revisarConversacionesAutomaticas] No se pudo avisar por Telegram (no crítico):", error));

  return true;
}

/**
 * Job periódico (más frecuente que la revisión normal de correo — ver
 * scheduler.ts) para la conversación automática con contactos pre-aprobados
 * (ver autorespuestaContactoStore.ts). Pedido explícito de Carlos, tras usar
 * el sistema: la aprobación de un CONTACTO no basta — "puedes recibir varios
 * e-mails de la misma persona y no en todos debes responder
 * automáticamente". Por eso cada HILO (no solo cada contacto) necesita su
 * propia aprobación, una sola vez (ver hiloAutorespuestaStore.ts):
 * - hilo nunca visto de un contacto aprobado → se pregunta por Telegram
 *   (botones Sí/No) y se guarda "pendiente" — NO se responde este turno;
 * - "pendiente" o "rechazado" → se salta (ya se preguntó, o Carlos ya dijo
 *   que no) — nunca se vuelve a preguntar por el mismo hilo;
 * - "aprobado" → se responde de verdad (procesarHiloAutorespuestaAprobado):
 *   usa el hilo COMPLETO como contexto, solo puede CONSULTAR datos reales
 *   (nunca escribir — ver responderCorreoAutomatico), lleva la leyenda de
 *   "respuesta automática" al final, y avisa a Carlos por Telegram sin botón.
 */
export async function revisarConversacionesAutomaticas(): Promise<{ respondidos: number; preguntados: number }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;
  if (!chatId) {
    console.error("[revisarConversacionesAutomaticas] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar ni preguntar.");
    return { respondidos: 0, preguntados: 0 };
  }

  const contactos = await listarContactosAutorespuesta();
  if (contactos.length === 0) return { respondidos: 0, preguntados: 0 }; // lista vacía — nunca escanea nada de más

  const threadIds = await listarHilosNoLeidosDe(contactos.map((c) => c.email));

  let respondidos = 0;
  let preguntados = 0;

  for (const threadId of threadIds) {
    try {
      const estadoHilo = await obtenerEstadoHiloAutorespuesta(threadId);

      if (estadoHilo?.estado === "pendiente" || estadoHilo?.estado === "rechazado") continue;

      if (!estadoHilo) {
        // Hilo nunca visto — preguntar en vez de responder solo.
        const hilo = await obtenerHiloCompleto(threadId);
        if (!hilo.ultimoMensajeId) continue;
        const ultimoMensaje = hilo.mensajes[hilo.mensajes.length - 1];
        if (!ultimoMensaje || ultimoMensaje.esNuestro) continue;

        await crearPendienteAprobacionHilo(threadId, chatId, hilo.ultimoDe, hilo.asunto || "(sin asunto)");
        await sendTelegramMessageWithButtons(
          chatId,
          `🤖 Nueva conversación con ${hilo.ultimoDe} ("${hilo.asunto || "(sin asunto)"}") — ¿esta conversación también es automática ` +
            `(respondo solo, sin pedirte aprobación cada vez)?`,
          [
            [
              { text: "✅ Sí, automática", callback_data: `autohilo_aprobar:${threadId}` },
              { text: "❌ No, normal", callback_data: `autohilo_rechazar:${threadId}` },
            ],
          ]
        );
        preguntados++;
        continue;
      }

      // estadoHilo.estado === "aprobado"
      const respondido = await procesarHiloAutorespuestaAprobado(threadId, chatId);
      if (respondido) respondidos++;
    } catch (error) {
      console.error(`[revisarConversacionesAutomaticas] Error procesando el hilo ${threadId} (se reintenta en la próxima corrida):`, error);
    }
  }

  return { respondidos, preguntados };
}
