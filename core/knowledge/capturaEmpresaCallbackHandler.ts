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
      { text: "✅ Confirmar", callback_data: "capturaempresa_confirmar" },
      { text: "❌ Cancelar", callback_data: "capturaempresa_cancelar" },
    ],
  ];
}

function mensajePregunta(): string {
  return "📌 Guardado el texto. ¿A qué empresa corresponde? Puedes elegir varias.";
}

/**
 * Envía el mensaje inicial con los botones de selección de empresa y guarda
 * el pendiente correspondiente — se llama justo después de detectar un
 * mensaje CAPTURA de texto/caption normal (no el flujo de lectura de correo,
 * que ya se resuelve solo vía Claude). Sin esta pregunta, las capturas
 * quedaban sin ninguna empresa asociada y era más difícil confiar en que el
 * asistente las reconociera correctamente al consultarlas después.
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
    await editTelegramMessage(chatId, pendiente.messageId, "❌ Captura descartada.", []);
    return;
  }

  if (data === "capturaempresa_confirmar") {
    if (pendiente.empresasSeleccionadas.length === 0) {
      await answerCallbackQuerySafe(callback.id, "Selecciona al menos una empresa antes de confirmar.");
      return;
    }

    await eliminarPendienteCapturaEmpresa(chatId);
    await answerCallbackQuerySafe(callback.id, "Guardado");

    try {
      await registrarCaptura(pendiente.texto, pendiente.autor, pendiente.empresasSeleccionadas);
      await editTelegramMessage(
        chatId,
        pendiente.messageId,
        `✅ Guardado — ${pendiente.empresasSeleccionadas.join(", ")}.`,
        []
      );
    } catch (error) {
      console.error("Error guardando captura de conocimiento:", error);
      await editTelegramMessage(chatId, pendiente.messageId, "⚠️ Hubo un error guardando la captura. Intenta de nuevo.", []);
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
