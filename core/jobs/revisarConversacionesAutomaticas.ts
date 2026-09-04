import { listarContactosAutorespuesta } from "../gmail/autorespuestaContactoStore";
import { listarHilosNoLeidosDe, obtenerHiloCompleto, marcarHiloComoLeido, enviarCorreo } from "../gmail/client";
import { responderCorreoAutomatico } from "../claude/client";
import { sendTelegramMessage } from "../telegram/client";

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
 * Job periódico (más frecuente que la revisión normal de correo — ver
 * scheduler.ts) para la conversación automática con contactos pre-aprobados
 * (ver autorespuestaContactoStore.ts): lee, redacta y ENVÍA la respuesta
 * SIN esperar aprobación por mensaje — pedido explícito de Carlos, único
 * flujo de correo del sistema que hace esto. Cada respuesta:
 * - usa el hilo COMPLETO como contexto (no solo el último mensaje), para
 *   sostener la conversación con fluidez;
 * - solo puede CONSULTAR datos reales (Drive/cashflow/Holded de solo
 *   lectura — ver responderCorreoAutomatico), nunca escribir nada;
 * - lleva la leyenda de "respuesta automática" al final;
 * - se avisa a Carlos por Telegram (sin botón, solo para que nunca haya una
 *   conversación de la que no se enteró — pedido explícito).
 */
export async function revisarConversacionesAutomaticas(): Promise<{ respondidos: number }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  const contactos = await listarContactosAutorespuesta();
  if (contactos.length === 0) return { respondidos: 0 }; // lista vacía — nunca escanea nada de más

  const threadIds = await listarHilosNoLeidosDe(contactos.map((c) => c.email));

  let respondidos = 0;
  for (const threadId of threadIds) {
    try {
      const hilo = await obtenerHiloCompleto(threadId);
      if (!hilo.ultimoMensajeId) continue;

      // El último mensaje del hilo es NUESTRO (ya respondimos y la otra persona no ha vuelto a
      // escribir) — nada nuevo que responder, evita un bucle de "responder a mi propia respuesta".
      const ultimoMensaje = hilo.mensajes[hilo.mensajes.length - 1];
      if (!ultimoMensaje || ultimoMensaje.esNuestro) continue;

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
        continue;
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
      respondidos++;

      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `🤖 Conversación automática — respondí a ${hilo.ultimoDe} ("${hilo.asunto}"):\n\n${respuesta}`
        ).catch((error) => console.error("[revisarConversacionesAutomaticas] No se pudo avisar por Telegram (no crítico):", error));
      }
    } catch (error) {
      console.error(`[revisarConversacionesAutomaticas] Error procesando el hilo ${threadId} (se reintenta en la próxima corrida):`, error);
    }
  }

  return { respondidos };
}
