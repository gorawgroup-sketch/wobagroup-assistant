import { sendTelegramMessageWithButtons, editTelegramMessage, answerCallbackQuery } from "../telegram/client";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import {
  obtenerSolicitudAcceso,
  resolverSolicitudAcceso,
  registrarNotificaciones,
  type SolicitudAcceso,
  type NotificacionEnviada,
} from "./accesoSolicitudSheet";
import { crearTokenTemporal } from "./tempTokenStore";
import { registrarAccesoMaestroOtorgado } from "./accesoMaestroAuditSheet";
import type { TelegramCallbackQuery } from "../telegram/types";

/**
 * Notifica a TODOS los admins que alguien pide acceso al front del cerebro,
 * con 3 botones: aprobar temporal (24h), aprobar con la key maestra, o
 * rechazar — el admin decide cuál según quién sea la persona. Nunca entrega
 * acceso por sí sola.
 */
export async function notificarSolicitudAccesoCerebro(solicitud: SolicitudAcceso): Promise<void> {
  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error("[cerebro/accesoCallbackHandler] No hay ningún admin registrado, no se puede notificar.");
    return;
  }

  const texto = [
    `🧠 *Solicitud de acceso al cerebro*`,
    ``,
    `Nombre: ${solicitud.nombre || "(sin nombre)"}`,
    ``,
    `¿Le doy acceso? Elige según quién sea:`,
  ].join("\n");

  const botones = [
    [
      { text: "⏱️ Temporal (24h)", callback_data: `cerebroacceso_temporal:${solicitud.id}` },
      { text: "🔑 Key maestra", callback_data: `cerebroacceso_maestro:${solicitud.id}` },
    ],
    [{ text: "❌ Rechazar", callback_data: `cerebroacceso_rechazar:${solicitud.id}` }],
  ];

  const notificaciones: NotificacionEnviada[] = [];

  for (const admin of admins) {
    try {
      const messageId = await sendTelegramMessageWithButtons(admin.userId, texto, botones);
      notificaciones.push({ chatId: admin.userId, messageId });
    } catch (error) {
      console.error(`[cerebro/accesoCallbackHandler] Error notificando a admin ${admin.userId}:`, error);
    }
  }

  await registrarNotificaciones(solicitud.id, notificaciones);
}

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[cerebro/accesoCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

/** Edita el mensaje en TODOS los chats de admin donde se notificó, para que no queden botones activos en otros chats tras resolverse. */
async function editarTodasLasNotificaciones(notificaciones: NotificacionEnviada[], texto: string): Promise<void> {
  for (const n of notificaciones) {
    await editTelegramMessage(n.chatId, n.messageId, texto, []).catch((error) => {
      console.error(`[cerebro/accesoCallbackHandler] Error editando notificación en chat ${n.chatId}:`, error);
    });
  }
}

/**
 * Maneja los botones cerebroacceso_temporal / cerebroacceso_maestro /
 * cerebroacceso_rechazar. Solo un admin puede llegar aquí (esAccionSensible
 * gatea temporal/maestro en server.ts) — rechazar queda abierto a cualquier
 * admin sin distinción adicional.
 */
export async function handleAccesoCerebroCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");
  const solicitud = await obtenerSolicitudAcceso(id);

  if (!solicitud || solicitud.estado !== "pendiente") {
    await answerCallbackQuerySafe(callback.id, "Esta solicitud ya no está disponible (resuelta o vencida).");
    return;
  }

  if (accion === "cerebroacceso_rechazar") {
    await answerCallbackQuerySafe(callback.id, "Rechazado.");
    await resolverSolicitudAcceso(id, "rechazado");
    await editarTodasLasNotificaciones(solicitud.notificaciones, `❌ Rechazado — ${solicitud.nombre}`);
    return;
  }

  if (accion === "cerebroacceso_temporal") {
    await answerCallbackQuerySafe(callback.id, "Generando acceso temporal...");
    try {
      const { token, expiraEn } = await crearTokenTemporal(solicitud.nombre);
      await resolverSolicitudAcceso(id, "aprobado_temporal", token);
      const horas = Math.round((expiraEn - Date.now()) / 3600000);
      await editarTodasLasNotificaciones(
        solicitud.notificaciones,
        `✅ Acceso temporal (${horas}h) — ${solicitud.nombre}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[cerebro/accesoCallbackHandler] Error creando token temporal:", message);
      await editarTodasLasNotificaciones(solicitud.notificaciones, `⚠️ Error dando acceso a ${solicitud.nombre}\n\n${message}`);
    }
    return;
  }

  if (accion === "cerebroacceso_maestro") {
    await answerCallbackQuerySafe(callback.id, "Entregando key maestra...");
    const cerebroKey = process.env.CEREBRO_API_KEY;
    if (!cerebroKey) {
      await editarTodasLasNotificaciones(solicitud.notificaciones, `⚠️ CEREBRO_API_KEY no configurada en el servidor — no se pudo dar acceso a ${solicitud.nombre}.`);
      return;
    }
    await resolverSolicitudAcceso(id, "aprobado_maestro", cerebroKey);
    await registrarAccesoMaestroOtorgado(solicitud.nombre);
    await editarTodasLasNotificaciones(solicitud.notificaciones, `✅ Acceso con key maestra — ${solicitud.nombre}`);
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}
