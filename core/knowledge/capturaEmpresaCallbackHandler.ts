import { answerCallbackQuery, editTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { registrarCaptura } from "./capturaSheet";
import {
  guardarPendienteCapturaEmpresa,
  obtenerPendienteCapturaEmpresa,
  eliminarPendienteCapturaEmpresa,
  type EmpresaCaptura,
} from "./pendienteCapturaEmpresaStore";
import type { TelegramCallbackQuery } from "../telegram/types";
import type { InlineKeyboardButton } from "../telegram/types";

const EMPRESAS: EmpresaCaptura[] = ["WOBA", "EWORKS", "Footprint", "General"];

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[capturaEmpresaCallbackHandler] No se pudo responder el callback_query (no crítico):", message);
  }
}

function construirTeclado(seleccionadas: EmpresaCaptura[]): InlineKeyboardButton[][] {
  const filaEmpresas = EMPRESAS.map((empresa) => ({
    text: seleccionadas.includes(empresa) ? `✅ ${empresa}` : empresa,
    callback_data: `capturaempresa_toggle:${empresa}`,
  }));

  return [
    filaEmpresas.slice(0, 2),
    filaEmpresas.slice(2),
    [
      { text: "✅ Confirmar y guardar", callback_data: "capturaempresa_confirmar" },
      { text: "❌ Cancelar", callback_data: "capturaempresa_cancelar" },
    ],
  ];
}

function mensajePregunta(): string {
  return "📌 Antes de guardar: ¿a qué empresa corresponde? Puedes elegir varias.";
}

/**
 * Envía el mensaje con los botones de selección de empresa y guarda el
 * pendiente correspondiente — el guardado real (registrarCaptura) ocurre
 * recién al presionar "✅ Confirmar y guardar" (ver handleCapturaEmpresaCallback),
 * nunca antes. Se llama justo después de detectar un mensaje CAPTURA de
 * texto/caption normal (no el flujo de lectura de correo, que se resuelve
 * solo vía Claude).
 */
export async function iniciarSeleccionEmpresaCaptura(chatId: number, texto: string, autor?: string): Promise<void> {
  const messageId = await sendTelegramMessageWithButtons(chatId, mensajePregunta(), construirTeclado([]));
  await guardarPendienteCapturaEmpresa({ chatId, messageId, texto, autor, empresasSeleccionadas: [] });
}

export async function handleCapturaEmpresaCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;

  if (!data || !chatId) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const pendiente = await obtenerPendienteCapturaEmpresa(chatId);
  if (!pendiente) {
    await answerCallbackQuerySafe(callback.id, "Esta selección ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (data === "capturaempresa_cancelar") {
    await eliminarPendienteCapturaEmpresa(chatId);
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(chatId, pendiente.messageId, "❌ Captura descartada — no se guardó nada.", []);
    return;
  }

  if (data === "capturaempresa_confirmar") {
    if (pendiente.empresasSeleccionadas.length === 0) {
      await answerCallbackQuerySafe(callback.id, "Selecciona al menos una empresa antes de confirmar.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Guardando...");

    // El guardado es lo único que de verdad importa acá — solo se elimina el
    // pendiente y se confirma al usuario DESPUÉS de que registrarCaptura
    // termine sin lanzar error. Si falla, el pendiente se deja intacto para
    // poder reintentar con los mismos botones, y se avisa explícitamente en
    // vez de decir "guardado" sobre algo que no se guardó.
    try {
      await registrarCaptura(pendiente.texto, pendiente.autor, pendiente.empresasSeleccionadas);
      await eliminarPendienteCapturaEmpresa(chatId);
      await editTelegramMessage(
        chatId,
        pendiente.messageId,
        `✅ Guardado — ${pendiente.empresasSeleccionadas.join(", ")}.`,
        []
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error guardando captura de conocimiento:", message);
      await editTelegramMessage(
        chatId,
        pendiente.messageId,
        `❌ No se pudo guardar la captura (error: ${message}). La selección de empresa se mantiene — puedes ` +
          "volver a presionar Confirmar para reintentar, o escribir el CAPTURA de nuevo.",
        construirTeclado(pendiente.empresasSeleccionadas)
      );
    }
    return;
  }

  if (data.startsWith("capturaempresa_toggle:")) {
    const empresa = data.split(":")[1] as EmpresaCaptura;
    if (!EMPRESAS.includes(empresa)) {
      await answerCallbackQuerySafe(callback.id);
      return;
    }

    // "General" es excluyente con las empresas específicas (y viceversa) —
    // no tiene sentido marcar "General" junto con "WOBA" a la vez.
    let seleccionadas: EmpresaCaptura[];
    if (empresa === "General") {
      seleccionadas = pendiente.empresasSeleccionadas.includes("General") ? [] : ["General"];
    } else if (pendiente.empresasSeleccionadas.includes(empresa)) {
      seleccionadas = pendiente.empresasSeleccionadas.filter((e) => e !== empresa);
    } else {
      seleccionadas = [...pendiente.empresasSeleccionadas.filter((e) => e !== "General"), empresa];
    }

    await guardarPendienteCapturaEmpresa({ ...pendiente, empresasSeleccionadas: seleccionadas });
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(chatId, pendiente.messageId, mensajePregunta(), construirTeclado(seleccionadas));
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}
