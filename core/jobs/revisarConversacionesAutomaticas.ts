import Anthropic from "@anthropic-ai/sdk";
import { listarContactosAutorespuesta } from "../gmail/autorespuestaContactoStore";
import { listarHilosNoLeidosDe, obtenerHiloCompleto, marcarHiloComoLeido, enviarCorreo, consultarEnvioCorreoExistente, type MensajeDeHilo } from "../gmail/client";
import { obtenerEstadoHiloAutorespuesta, crearPendienteAprobacionHilo } from "../gmail/hiloAutorespuestaStore";
import { responderCorreoAutomatico } from "../claude/client";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { crearMensajeAnthropic } from "../ai/anthropicGateway";
import { crearEjecucionIA } from "../ai/policy";
import { resolverModeloDocumental } from "../ai/modelRouting";
import { enteroAcotado } from "../utils/asyncTimeout";

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

  // Hallazgo real de auditoría (caso real Carlos, hilo Alberto Comolli <> Sofía Sabjan de 3G Office,
  // "Saldo proyecto Electra"): la aprobación es por HILO completo, pero a quién va dirigido cada
  // mensaje puede cambiar de uno a otro dentro del mismo hilo — Alberto escribía "To: Sofía Sabjan",
  // solo copiando ("Cc") a asistente@wobagroup.com para que Carlos tuviera visibilidad, y este job
  // igual respondía como si la conversación fuera CON Wobi, generando una respuesta confusa dirigida
  // a un tercero externo real que ni siquiera esperaba oír de nosotros. Si Wobi no aparece en el "To"
  // de ESTE mensaje concreto (solo en copia, o ni eso), no hay nada que un asistente automático deba
  // responder — se avisa a Carlos por si quiere intervenir él mismo, y se marca leído para no
  // repetir el mismo aviso cada 15 minutos mientras nadie lo atienda.
  if (!ultimoMensaje.dirigidoANosotros) {
    await marcarHiloComoLeido(threadId);
    await sendTelegramMessage(
      chatId,
      `ℹ️ ${hilo.ultimoDe} escribió en "${hilo.asunto}" pero solo nos tiene en copia (Cc) — no nos escribe ` +
        `directamente a nosotros (To: ${ultimoMensaje.para || "desconocido"}). No respondí automáticamente; revísalo si hace falta intervenir.`
    ).catch((error) => console.error("[revisarConversacionesAutomaticas] No se pudo avisar por Telegram (no crítico):", error));
    return false;
  }

  const idempotencyKey = `autorespuesta:${hilo.ultimoMensajeId}`;
  const envioExistente = await consultarEnvioCorreoExistente(idempotencyKey);
  if (envioExistente) {
    // El envío ya estaba confirmado (posible recuperación tras reinicio):
    // cerrar el hilo sin volver a gastar IA ni mandar otra notificación.
    await marcarHiloComoLeido(threadId);
    return true;
  }

  const hiloTexto = hilo.mensajes
    .map((m) => `[${m.esNuestro ? "Wobi (nosotros)" : m.de}] — ${m.fecha}:\n${m.cuerpo}`)
    .join("\n\n---\n\n");

  const respuesta = await responderCorreoAutomatico({
    remitente: hilo.ultimoDe,
    asunto: hilo.asunto,
    hiloTexto,
    ultimoPara: ultimoMensaje.para,
    ultimoCc: ultimoMensaje.cc,
  });

  if (!respuesta.trim()) {
    // Puede ser una respuesta genuinamente vacía (error de IA, reintentar), o una decisión explícita
    // de no responder porque el mensaje va dirigido a otra persona (ver SYSTEM_PROMPT_RESPUESTA_AUTOMATICA)
    // — en ambos casos lo correcto es lo mismo: no enviar nada y no dar el hilo por resuelto todavía.
    console.error(`[revisarConversacionesAutomaticas] Sin respuesta para el hilo ${threadId} (vacía, o decisión de no intervenir) — se salta, se reintenta en la próxima corrida.`);
    return false;
  }

  await enviarCorreo({
    to: hilo.ultimoDe,
    asunto: hilo.asunto || "(sin asunto)",
    cuerpo: respuesta,
    idempotencyKey,
    proceso: "autorespuesta",
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

let clienteResumen: Anthropic | null = null;
function getClienteResumen(): Anthropic {
  if (clienteResumen) return clienteResumen;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
  clienteResumen = new Anthropic({ apiKey });
  return clienteResumen;
}

/**
 * Pedido explícito de Carlos (2026-09-16): la pregunta "¿esta conversación también es automática?"
 * solo mostraba remitente y asunto — sin haber leído nada del hilo, era imposible decidir con
 * criterio si activar la auto-respuesta. obtenerHiloCompleto YA trae todos los mensajes reales antes
 * de preguntar; este resumen solo los aprovecha. Nunca decide nada por Carlos — solo describe de qué
 * trata la conversación y qué se ha dicho hasta ahora, para que la decisión "sí/no automática" sea
 * informada. Si falla (sin API key, error de red), se degrada a la pregunta sin resumen — preguntar
 * sigue siendo mejor que no preguntar, aunque falte el contexto.
 */
async function resumirHiloParaAprobacion(mensajes: MensajeDeHilo[]): Promise<string | undefined> {
  try {
    const anthropic = getClienteResumen();
    const transcripcion = mensajes
      .slice(-6) // suficiente para juzgar el tema y el estado actual sin gastar de más en hilos largos
      .map((m) => `De: ${m.de}\n${m.cuerpo.trim().slice(0, 1500)}`)
      .join("\n---\n");
    const response = await crearMensajeAnthropic(anthropic, crearEjecucionIA("resumir_hilo_aprobacion"), {
      model: resolverModeloDocumental("resumir_hilo_aprobacion"),
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content:
            `Resume en 2-3 frases, en español, de qué trata esta conversación de correo y qué se ha ` +
            `dicho o decidido hasta ahora (si hay algún acuerdo, pregunta pendiente, o dato concreto, ` +
            `inclúyelo). Es para que un humano decida si activar respuestas automáticas para este hilo, ` +
            `así que prioriza lo que ayude a esa decisión. Sin introducción ni encabezado, solo el resumen.\n\n${transcripcion}`,
        },
      ],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    const resumen = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    return resumen || undefined;
  } catch (error) {
    console.error("[revisarConversacionesAutomaticas] Error resumiendo el hilo para la pregunta de aprobación (no crítico, se pregunta sin resumen):", error);
    return undefined;
  }
}

export async function revisarConversacionesAutomaticas(): Promise<{ respondidos: number; preguntados: number }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;
  if (!chatId) {
    console.error("[revisarConversacionesAutomaticas] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar ni preguntar.");
    return { respondidos: 0, preguntados: 0 };
  }

  const contactos = await listarContactosAutorespuesta();
  if (contactos.length === 0) return { respondidos: 0, preguntados: 0 }; // lista vacía — nunca escanea nada de más

  // Una sola consulta de Gmail, ya filtrada por los remitentes aprobados. El
  // tope evita que una avalancha o un buzón atrasado dispare muchas llamadas
  // de IA en una misma corrida; el resto queda sin leer para el siguiente pase.
  const todosLosThreadIds = await listarHilosNoLeidosDe(contactos.map((c) => c.email));
  const maxHilos = enteroAcotado(process.env.WOBI_AUTOREPLY_MAX_THREADS_PER_RUN, 3, 1, 20);
  const threadIds = todosLosThreadIds.slice(0, maxHilos);
  if (todosLosThreadIds.length > threadIds.length) {
    console.log(`[revisarConversacionesAutomaticas] ${todosLosThreadIds.length - threadIds.length} hilo(s) quedan para el próximo pase por el límite de costo.`);
  }

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
        const resumen = await resumirHiloParaAprobacion(hilo.mensajes);
        await sendTelegramMessageWithButtons(
          chatId,
          `🤖 Nueva conversación con ${hilo.ultimoDe} ("${hilo.asunto || "(sin asunto)"}")` +
            (resumen ? `\n\n${resumen}` : "") +
            `\n\n¿esta conversación también es automática (respondo solo, sin pedirte aprobación cada vez)?`,
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
