import type { Empresa } from "../holded/client";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import type { InlineKeyboardButton, TelegramCallbackQuery } from "../telegram/types";
import { activarModoSoportes, cerrarModoSoportes } from "./modoSoportesStore";

/**
 * «/soportes» en el menú de Telegram: arranca el proceso semanal de pedir soportes a quien gastó con la tarjeta. Pregunta
 * de qué empresa es el CSV de Revolut que se va a subir y deja el chat esperándolo; el siguiente CSV de ese chat se lee
 * con esa empresa, sin depender de que el texto del archivo esté bien escrito (analizar y enviar: campanaSoportes.ts).
 */

export const EMPRESAS_SOPORTES: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

const botonesEmpresa = (): InlineKeyboardButton[] => EMPRESAS_SOPORTES.map((e) => ({ text: e, callback_data: `sopm_e:${e}` }));

export const TEXTO_SUBIR = (empresa: Empresa): string =>
  `📎 Listo: sube ahora el CSV de Revolut de ${empresa} (Revolut Business → la cuenta → Movimientos → Exportar CSV).\n` +
  "No hace falta que escribas nada con el archivo: lo leo igual. Si la empresa tiene varias cuentas (por ejemplo EUR y USD), súbelas una detrás de otra y te pregunto la empresa cada vez.";

/** Respuesta a «/soportes»: con empresa va directo a pedir el archivo; sin ella, pregunta cuál. */
export async function iniciarSoportes(chatId: number, empresa?: Empresa): Promise<void> {
  if (empresa) {
    await activarModoSoportes(chatId, empresa);
    await sendTelegramMessageWithButtons(chatId, TEXTO_SUBIR(empresa), [[{ text: "❌ Cancelar", callback_data: "sopm_f" }]]);
    return;
  }
  await sendTelegramMessageWithButtons(
    chatId,
    "🧾 Pedir soportes a quien gastó con la tarjeta.\n¿De qué empresa es el primer CSV de Revolut que vas a subir?",
    [botonesEmpresa(), [{ text: "❌ Cancelar", callback_data: "sopm_f" }]]
  );
}

/** Tras analizar un CSV: ofrece seguir con otro (de otra empresa o de otra cuenta de la misma) o terminar. */
export async function ofrecerOtroCsv(chatId: number, empresaHecha: Empresa): Promise<void> {
  await sendTelegramMessageWithButtons(
    chatId,
    `✅ Terminé con el CSV de ${empresaHecha}. ¿Vas a subir otro (de otra empresa, o de otra cuenta de ${empresaHecha})? Elige de cuál y súbelo; si no, pulsa «Terminé».`,
    [botonesEmpresa(), [{ text: "✅ Terminé", callback_data: "sopm_f" }]]
  );
}

async function responder(id: string, texto?: string): Promise<void> {
  try { await answerCallbackQuery(id, texto); } catch (error) {
    console.error("[soportes] No se pudo responder al botón (no crítico):", error instanceof Error ? error.message : error);
  }
}

export async function handleSoportesModoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  const [accion, empresa] = (callback.data ?? "").split(":");
  if (!chatId || !messageId) { await responder(callback.id, "Petición no válida."); return; }

  if (accion === "sopm_f") {
    await cerrarModoSoportes(chatId);
    await responder(callback.id, "Hecho.");
    await editTelegramMessage(chatId, messageId, "👍 De acuerdo, no espero más extractos. Cuando quieras volver a empezar, pulsa /soportes.", []);
    return;
  }
  if (accion === "sopm_e" && EMPRESAS_SOPORTES.includes(empresa as Empresa)) {
    await activarModoSoportes(chatId, empresa as Empresa);
    await responder(callback.id, `Esperando el CSV de ${empresa}.`);
    await editTelegramMessage(chatId, messageId, TEXTO_SUBIR(empresa as Empresa), [[{ text: "❌ Cancelar", callback_data: "sopm_f" }]]);
    return;
  }
  await responder(callback.id, "Acción desconocida.");
}
