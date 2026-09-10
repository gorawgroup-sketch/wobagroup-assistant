import { answerCallbackQuery, editTelegramMessage } from "../telegram/client";
import { obtenerEscalacionDesarrollo, consumirEscalacionDesarrollo } from "./escalacionDesarrolloStore";
import { crearIssue } from "./client";
import type { TelegramCallbackQuery } from "../telegram/types";

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[escalacionCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

/**
 * Etiqueta que dispara el flujo automático de autofix por Issue (ver
 * .github/workflows/claude-issue-autofix.yml, `label_trigger`) — debe coincidir EXACTO con el valor
 * configurado ahí. Pedido explícito de Carlos: al pulsar "Crear issue", además de quedar registrado
 * para development, que se le envíe la solicitud a Claude para que investigue y proponga un arreglo
 * real — mismo patrón de seguridad ya establecido (PR + aprobación por botón en Telegram antes de
 * fusionar, nunca se despliega nada sin ese tap), pero SIN la restricción de archivos "solo
 * core/utils/" de la autorrevisión nocturna (decisión explícita de Carlos: para que sirva contra los
 * bugs reales que se escalan, que normalmente son de dinero/Holded/cashflow).
 */
const ETIQUETA_AUTOFIX = "wobi-auto-fix";

/**
 * Marcador oculto (comentario HTML, invisible en la vista renderizada de GitHub) con el chatId de
 * Telegram donde se originó la escalación — el workflow de autofix lo extrae del cuerpo del issue
 * para saber a qué chat avisar cuando termine, sin necesitar ningún store aparte ni exponer el
 * chatId en el texto visible del issue.
 */
function marcadorChatId(chatId: number): string {
  return `<!-- wobi-chat-id:${chatId} -->`;
}

/**
 * Maneja los botones de una propuesta de escalación a development
 * (escaladev_confirmar / escaladev_cancelar) — solo "escaladev_confirmar"
 * crea el GitHub Issue real, es el único punto de todo el sistema donde
 * ocurre esa escritura.
 */
export async function handleEscalacionCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, id] = data.split(":");

  if (accion === "escaladev_cancelar") {
    const escalacion = await consumirEscalacionDesarrollo(id);
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    if (escalacion) {
      await editTelegramMessage(escalacion.chatId, escalacion.messageId, `❌ Cancelado — no se creó ningún issue ("${escalacion.titulo}").`, []);
    }
    return;
  }

  // escaladev_confirmar
  const escalacion = await obtenerEscalacionDesarrollo(id);
  if (!escalacion) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
    return;
  }

  await answerCallbackQuerySafe(callback.id, "Creando issue...");

  const cuerpoFinal =
    (escalacion.urgente
      ? `🔴 **URGENTE** — reportado por Carlos desde el chat.\n\n${escalacion.cuerpo}`
      : `${escalacion.cuerpo}\n\n---\nReportado desde el chat de WOBI.`) + `\n\n${marcadorChatId(escalacion.chatId)}`;

  try {
    const labels = [ETIQUETA_AUTOFIX, ...(escalacion.urgente ? ["urgente"] : [])];
    const issue = await crearIssue({ titulo: escalacion.titulo, cuerpo: cuerpoFinal, labels });

    // Solo se consume (se descarta) el borrador si la creación tuvo éxito — si falla, se conserva
    // para poder reintentar sin perder el texto, mismo criterio que draft_enviar (correo).
    await consumirEscalacionDesarrollo(id);

    await editTelegramMessage(
      escalacion.chatId,
      escalacion.messageId,
      `✅ Issue creado: ${issue.url} (#${issue.numero}).\n\n🤖 Claude ya está investigando un arreglo — si propone uno, te aviso aquí mismo con un Pull Request para aprobar (nada se fusiona sin tu confirmación).`,
      []
    );
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[escalacionCallbackHandler] Error creando el issue en GitHub:", mensaje);
    await editTelegramMessage(
      escalacion.chatId,
      escalacion.messageId,
      `⚠️ Error creando el issue en GitHub: ${mensaje}. Puede que GITHUB_TOKEN no tenga permiso de escritura ` +
        `sobre Issues (Settings → Developer settings → Fine-grained tokens, permiso "Issues: Read and write"). ` +
        `La propuesta se conserva — puedes volver a intentarlo.`,
      [
        [
          { text: "📤 Crear issue", callback_data: `escaladev_confirmar:${escalacion.id}` },
          { text: "❌ Cancelar", callback_data: `escaladev_cancelar:${escalacion.id}` },
        ],
      ]
    );
  }
}
