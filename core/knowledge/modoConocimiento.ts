import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  answerCallbackQuery,
  editTelegramMessageReplyMarkup,
  sendTelegramMessage,
  sendTelegramMessageWithButtons,
} from "../telegram/client";
import type { InlineKeyboardButton, TelegramCallbackQuery } from "../telegram/types";
import { transcribirParaCaptura } from "../documental/transcribeForCapture";
import { registrarCaptura } from "./capturaSheet";
import { activarModoConocimiento, cerrarModoConocimiento, leerModoConocimiento, VIGENCIA_MODO_CONOCIMIENTO_MS } from "./modoConocimientoStore";

/**
 * /conocimiento — un solo toque en el menú de Telegram y todo lo que se envíe después (texto, enlaces, documentos, fotos) se guarda
 * como CONOCIMIENTO de los agentes (la misma base de capturas que consulta Wobi), sin pasar por ningún otro flujo: ni gasto, ni
 * archivado en Drive, ni la IA conversacional. Termina con «Terminar» o a los 30 min sin enviar nada.
 */
export const EMPRESAS_CONOCIMIENTO = ["WOBA", "EWORKS", "Footprint", "General"] as const;
const MAX_BYTES_ARCHIVO = 15 * 1024 * 1024;
const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export function parsearComandoConocimiento(texto: string): boolean {
  return /^\/(conocimiento|aprender)(@\w+)?\s*$/i.test(texto.trim());
}

/** Marca o desmarca una empresa; sin ninguna marcada se vuelve a «General» (todos los agentes). */
export function alternarEmpresaConocimiento(seleccionadas: readonly string[], empresa: string): string[] {
  const siguientes = seleccionadas.includes(empresa) ? seleccionadas.filter((e) => e !== empresa) : [...seleccionadas, empresa];
  const conocidas = EMPRESAS_CONOCIMIENTO.filter((e) => siguientes.includes(e));
  return conocidas.length > 0 ? [...conocidas] : ["General"];
}

export function tecladoModoConocimiento(seleccionadas: readonly string[]): InlineKeyboardButton[][] {
  const empresas = EMPRESAS_CONOCIMIENTO.map((e) => ({ text: seleccionadas.includes(e) ? `✅ ${e}` : e, callback_data: `conoc_t:${e}` }));
  return [empresas.slice(0, 2), empresas.slice(2), [{ text: "🏁 Terminar", callback_data: "conoc_fin" }]];
}

export function mensajeModoConocimiento(seleccionadas: readonly string[]): string {
  return (
    "🧠 *Modo conocimiento activo.*\n" +
    "Mándame ahora lo que quieras que aprendan los agentes: documentos, fotos, enlaces o texto. Todo lo que envíes se guarda como " +
    "conocimiento y no se procesa de ninguna otra forma (ni gasto, ni archivo en Drive).\n\n" +
    `Para: ${seleccionadas.join(", ")} (cámbialo con los botones).\n` +
    `Se cierra solo tras ${VIGENCIA_MODO_CONOCIMIENTO_MS / 60_000} min sin enviar nada; pulsa «Terminar» cuando acabes.`
  );
}

/** Texto a guardar: un enlace se guarda como referencia (no se abre la página); el resto, tal cual. */
export function prepararCapturaDeTexto(texto: string): { contenido: string; resumen: string; conEnlaces: boolean } {
  const limpio = texto.trim();
  const enlaces = limpio.match(URL_RE) ?? [];
  if (enlaces.length === 0) return { contenido: limpio, resumen: limpio.replace(/\s+/g, " ").slice(0, 70), conEnlaces: false };
  const resto = limpio.replace(URL_RE, "").replace(/\s+/g, " ").trim();
  const contenido = [`Enlace${enlaces.length > 1 ? "s" : ""}: ${enlaces.join(" , ")}`, resto ? `Nota: ${resto}` : ""].filter(Boolean).join("\n");
  return { contenido, resumen: (enlaces[0] ?? "").slice(0, 70), conEnlaces: true };
}

function confirmacion(empresas: readonly string[], que: string, extra = ""): string {
  return `✅ Guardado como conocimiento (${empresas.join(", ")}): ${que}${extra}\nSigo esperando más; pulsa «Terminar» o usa /conocimiento para cambiar el destino.`;
}

export async function iniciarModoConocimiento(chatId: number): Promise<void> {
  const empresas = ["General"];
  await activarModoConocimiento(chatId, empresas);
  await sendTelegramMessageWithButtons(chatId, mensajeModoConocimiento(empresas), tecladoModoConocimiento(empresas));
}

export async function handleModoConocimientoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  const data = callback.data ?? "";
  if (!chatId || !messageId) { await answerCallbackQuery(callback.id).catch(() => {}); return; }
  const modo = await leerModoConocimiento(chatId);
  if (data === "conoc_fin") {
    await cerrarModoConocimiento(chatId);
    await answerCallbackQuery(callback.id, "Modo conocimiento terminado.").catch(() => {});
    await sendTelegramMessage(chatId, "🏁 Modo conocimiento terminado. Lo que mandes ahora vuelve a procesarse como siempre.");
    await editTelegramMessageReplyMarkup(chatId, messageId, []).catch(() => {});
    return;
  }
  if (!modo) {
    await answerCallbackQuery(callback.id, "El modo conocimiento ya terminó. Usa /conocimiento para empezar otra vez.").catch(() => {});
    await editTelegramMessageReplyMarkup(chatId, messageId, []).catch(() => {});
    return;
  }
  const empresa = data.startsWith("conoc_t:") ? data.slice("conoc_t:".length) : "";
  if (!(EMPRESAS_CONOCIMIENTO as readonly string[]).includes(empresa)) { await answerCallbackQuery(callback.id).catch(() => {}); return; }
  const nuevas = alternarEmpresaConocimiento(modo.empresas, empresa);
  await activarModoConocimiento(chatId, nuevas);
  await answerCallbackQuery(callback.id, `Para: ${nuevas.join(", ")}`).catch(() => {});
  await editTelegramMessageReplyMarkup(chatId, messageId, tecladoModoConocimiento(nuevas), mensajeModoConocimiento(nuevas))
    .catch((error) => console.error("[conocimiento] No se pudo repintar el teclado (no crítico):", error instanceof Error ? error.message : error));
}

export interface DependenciasModoConocimiento {
  leerModo: typeof leerModoConocimiento;
  renovarModo: typeof activarModoConocimiento;
  guardar: typeof registrarCaptura;
  transcribir: typeof transcribirParaCaptura;
  enviar: (chatId: number, texto: string) => Promise<void>;
}
const DEPENDENCIAS_REALES: DependenciasModoConocimiento = {
  leerModo: leerModoConocimiento, renovarModo: activarModoConocimiento, guardar: registrarCaptura, transcribir: transcribirParaCaptura, enviar: sendTelegramMessage,
};

/** Texto o enlace enviado con el modo activo. Devuelve true si lo atendió (el llamador no debe seguir procesándolo). */
export async function capturarTextoEnModoConocimiento(
  chatId: number, texto: string, autor?: string, deps: DependenciasModoConocimiento = DEPENDENCIAS_REALES
): Promise<boolean> {
  const modo = await deps.leerModo(chatId);
  if (!modo) return false;
  const { contenido, resumen, conEnlaces } = prepararCapturaDeTexto(texto);
  if (!contenido) return false;
  try {
    await deps.guardar(contenido, autor, modo.empresas);
    await deps.renovarModo(chatId, modo.empresas);
    await deps.enviar(chatId, confirmacion(modo.empresas, `«${resumen}${resumen.length >= 70 ? "…" : ""}»`, conEnlaces ? "\n(Guardé el enlace como referencia; no leí la página. Si quieres que aprendan su contenido, pega el texto o mándame el documento.)" : ""));
  } catch (error) {
    console.error("[conocimiento] Error guardando texto en modo conocimiento:", error instanceof Error ? error.message : error);
    await deps.enviar(chatId, "⚠️ No pude guardar eso como conocimiento: no se guardó nada. Inténtalo de nuevo; el modo sigue activo.").catch(() => {});
  }
  return true;
}

/** Documento o foto enviado con el modo activo (ya descargado). Devuelve true si lo atendió. */
export async function capturarArchivoEnModoConocimiento(
  chatId: number,
  archivo: { bytes: Buffer; nombre?: string; mimeType?: string; caption?: string; autor?: string },
  deps: DependenciasModoConocimiento = DEPENDENCIAS_REALES
): Promise<boolean> {
  const modo = await deps.leerModo(chatId);
  if (!modo) return false;
  const nombre = archivo.nombre ?? "(foto sin nombre)";
  if (archivo.bytes.length > MAX_BYTES_ARCHIVO) {
    await deps.enviar(chatId, `⚠️ «${nombre}» pesa demasiado para leerlo como conocimiento (máximo ${MAX_BYTES_ARCHIVO / 1024 / 1024} MB). No se guardó; el modo sigue activo.`);
    return true;
  }
  await deps.enviar(chatId, `📖 Leyendo «${nombre}» para guardarlo como conocimiento…`);
  const ruta = join(UPLOADS_DIR, `${Date.now()}_conocimiento_${nombre.replace(/[^\w.\-]+/g, "_")}`);
  try {
    await mkdir(UPLOADS_DIR, { recursive: true });
    await writeFile(ruta, archivo.bytes);
    const transcripcion = (await deps.transcribir(ruta, archivo.mimeType, archivo.caption)).trim();
    if (!transcripcion) throw new Error("la lectura del archivo no devolvió contenido");
    const contenido = [`Archivo: ${nombre}`, archivo.caption ? `Nota: ${archivo.caption}` : "", "", transcripcion].filter((l, i) => l !== "" || i === 2).join("\n");
    await deps.guardar(contenido, archivo.autor, modo.empresas);
    await deps.renovarModo(chatId, modo.empresas);
    await deps.enviar(chatId, confirmacion(modo.empresas, `«${nombre}» (${transcripcion.length.toLocaleString("es-ES")} caracteres leídos)`));
  } catch (error) {
    console.error("[conocimiento] Error guardando archivo en modo conocimiento:", error instanceof Error ? error.message : error);
    await deps.enviar(chatId, `⚠️ No pude leer «${nombre}» como conocimiento: no se guardó nada. Inténtalo de nuevo; el modo sigue activo.`).catch(() => {});
  } finally {
    await unlink(ruta).catch(() => {});
  }
  return true;
}
