import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { avanzarEstadoAutorrepair } from "./autorrepairPendienteStore";
import { fusionarPullRequest, cerrarPullRequestYBorrarRama } from "./client";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[autorrepairCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Botones "✅ Desplegar" / "❌ Descartar" de un hallazgo de la autorrevisión
 * nocturna de código (ver autorrevisionCodigo.ts) — la decisión MÁS
 * sensible de todo el sistema (Wobi modificando su propio código en
 * producción), centralizada en superadmin igual que el resto de
 * ACCIONES_SENSIBLES (ver authorizedUsersSheet.ts). "Desplegar" fusiona el
 * PR a main, lo que dispara el redeploy normal de Railway.
 *
 * Cada acción reclama primero un estado de TRÁNSITO ("desplegando"/
 * "descartando" — bloquea un doble-tap igual que un estado terminal) y
 * solo confirma el estado final si la llamada real a GitHub tuvo éxito; si
 * falla, revierte a "pendiente" para que el mismo botón se pueda volver a
 * tocar — hallazgo real de auditoría: sin esto, un fallo transitorio de
 * GitHub dejaba el registro atascado en "desplegado"/"descartado" para
 * siempre sin que nada se hubiera fusionado o cerrado de verdad.
 */
export async function handleAutorrepairCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  if (!data || !chatId || !messageId) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, numeroPRTexto] = data.split(":");
  const numeroPR = Number(numeroPRTexto);
  if (!Number.isFinite(numeroPR)) {
    await answerCallbackQuerySafe(callback.id, "Callback inválido.");
    return;
  }

  if (accion === "autorrepair_descartar") {
    const reclamado = await avanzarEstadoAutorrepair(numeroPR, "pendiente", "descartando");
    if (!reclamado) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    const cerrado = await cerrarPullRequestYBorrarRama(reclamado.numeroPR, reclamado.rama).catch((error) => {
      console.error(`[autorrepairCallbackHandler] Error cerrando PR #${reclamado.numeroPR}:`, error);
      return false;
    });

    if (!cerrado) {
      await avanzarEstadoAutorrepair(numeroPR, "descartando", "pendiente");
      await answerCallbackQuerySafe(callback.id, "Error al cerrar el PR — puedes volver a intentarlo.");
      return;
    }

    await avanzarEstadoAutorrepair(numeroPR, "descartando", "descartado");
    await answerCallbackQuerySafe(callback.id, "Descartado.");
    await editTelegramMessage(chatId, messageId, `❌ Descartado — \`${reclamado.ruta}\` sigue como está, el PR quedó cerrado sin fusionar.`, []);
    return;
  }

  if (accion === "autorrepair_desplegar") {
    const reclamado = await avanzarEstadoAutorrepair(numeroPR, "pendiente", "desplegando");
    if (!reclamado) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    const fusionado = await fusionarPullRequest(reclamado.numeroPR, reclamado.rama).catch((error) => {
      console.error(`[autorrepairCallbackHandler] Error fusionando PR #${reclamado.numeroPR}:`, error);
      return false;
    });

    if (!fusionado) {
      await avanzarEstadoAutorrepair(numeroPR, "desplegando", "pendiente");
      await answerCallbackQuerySafe(callback.id, "Error al fusionar — puedes volver a intentarlo.");
      await editTelegramMessage(
        chatId,
        messageId,
        `⚠️ No se pudo fusionar el PR de \`${reclamado.ruta}\` — puedes volver a tocar "✅ Desplegar", o revisarlo a mano: ${reclamado.urlPR}`,
        [[{ text: "✅ Desplegar", callback_data: `autorrepair_desplegar:${reclamado.numeroPR}` }, { text: "❌ Descartar", callback_data: `autorrepair_descartar:${reclamado.numeroPR}` }]]
      );
      return;
    }

    await avanzarEstadoAutorrepair(numeroPR, "desplegando", "desplegado");
    await answerCallbackQuerySafe(callback.id, "Desplegando...");
    await editTelegramMessage(
      chatId,
      messageId,
      `✅ Desplegado — el arreglo de \`${reclamado.ruta}\` está fusionado, Railway lo está desplegando ahora.`,
      []
    );
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}
