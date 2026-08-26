import { sendTelegramMessageWithButtons, answerCallbackQuery, editTelegramMessage } from "./client";
import { obtenerAdmins, autorizarUsuario } from "./authorizedUsersSheet";
import type { TelegramCallbackQuery } from "./types";

export interface SolicitanteBloqueado {
  userId: number;
  nombre: string;
  username?: string;
}

/**
 * Notifica a TODOS los administradores (por su chat privado — para un chat
 * 1:1 con el bot, chat_id == user_id) que alguien sin acceso intentó usar el
 * asistente, con botones para autorizarlo al instante. Nunca autoriza nada
 * por sí sola — solo avisa y ofrece los botones.
 */
export async function notificarSolicitudAcceso(solicitante: SolicitanteBloqueado): Promise<void> {
  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error(
      "[adminNotify] No hay ningún admin registrado en _usuarios_autorizados — nadie puede autorizar a nadie."
    );
    return;
  }

  const texto = [
    `🔔 *Solicitud de acceso*`,
    ``,
    `Nombre: ${solicitante.nombre || "(sin nombre)"}`,
    solicitante.username ? `Usuario: @${solicitante.username}` : `Usuario: (sin username)`,
    `ID: ${solicitante.userId}`,
    ``,
    `¿Le doy acceso?`,
  ].join("\n");

  for (const admin of admins) {
    await sendTelegramMessageWithButtons(admin.userId, texto, [
      [
        { text: "✅ Colaborador", callback_data: `auth_colaborador:${solicitante.userId}` },
        { text: "✅ Admin", callback_data: `auth_admin:${solicitante.userId}` },
      ],
      [{ text: "❌ Ignorar", callback_data: `auth_ignorar:${solicitante.userId}` }],
    ]).catch((error) => console.error(`[adminNotify] Error notificando a admin ${admin.userId}:`, error));
  }
}

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[adminNotify] No se pudo responder el callback_query (no crítico):", error);
  }
}

/**
 * Maneja los botones de autorización (auth_colaborador / auth_admin /
 * auth_ignorar). Solo debe llegar aquí un admin — server.ts ya filtra por
 * autorización antes de despachar cualquier callback_query.
 */
export async function handleAuthCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, idRaw] = data.split(":");
  const userId = Number(idRaw);

  if (!Number.isFinite(userId)) {
    await answerCallbackQuerySafe(callback.id, "ID inválido.");
    return;
  }

  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  if (accion === "auth_ignorar") {
    await answerCallbackQuerySafe(callback.id, "Ignorado.");
    if (chatId && messageId) {
      await editTelegramMessage(chatId, messageId, `❌ Ignorado — no se dio acceso a ${userId}.`, []);
    }
    return;
  }

  const rol = accion === "auth_admin" ? "admin" : "colaborador";

  await answerCallbackQuerySafe(callback.id, "Autorizando...");

  try {
    const chat = await fetchTelegramChat(userId);
    const nombre = [chat?.first_name, chat?.last_name].filter(Boolean).join(" ") || `Usuario ${userId}`;

    await autorizarUsuario(userId, rol, nombre);

    if (chatId && messageId) {
      await editTelegramMessage(chatId, messageId, `✅ Autorizado como ${rol} — ${nombre} (${userId}).`, []);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[adminNotify] Error autorizando usuario:", message);
    if (chatId && messageId) {
      await editTelegramMessage(chatId, messageId, `⚠️ Error al autorizar a ${userId}\n\n${message}`, []);
    }
  }
}

async function fetchTelegramChat(userId: number): Promise<{ first_name?: string; last_name?: string } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${userId}`);
    const data = (await res.json()) as { ok: boolean; result?: { first_name?: string; last_name?: string } };
    return data.ok ? data.result ?? null : null;
  } catch {
    return null;
  }
}
