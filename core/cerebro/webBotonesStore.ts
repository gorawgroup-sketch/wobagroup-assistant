import type { InlineKeyboardButton } from "../telegram/types";

/**
 * Pedido explícito de Carlos: que el chat web pueda resolver las mismas decisiones que hoy solo
 * existen como botones de Telegram (crear gasto vs. duplicado, clasificar un documento, aprobar
 * categorías de cashflow...). Telegram sigue siendo la única fuente de verdad de qué botones existen
 * de verdad (los maneja Telegram mismo, con su propio reply_markup) — esto es solo un ESPEJO en
 * memoria para que el panel web sepa qué mostrar y a qué callback_data corresponde cada botón.
 *
 * Deliberadamente en memoria, no en Sheets: sendTelegramMessageWithButtons/editTelegramMessageReplyMarkup
 * se llaman con muchísima frecuencia en todo el sistema — agregarles una escritura a Sheets en cada
 * llamada sumaría carga real a un camino ya caliente, por un dato que es puramente de presentación (la
 * fuente de verdad de cada decisión pendiente sigue viviendo en su propio store dedicado, como
 * siempre — gastoProposalSheet, pendienteReclasificacionStore, etc.). Tolerante a perderse en un
 * redeploy: un botón que sigue vivo en Telegram simplemente no aparece en el chat web hasta que se
 * regenere (ej. al reintentar la consulta), y sigue funcionando normal desde Telegram mientras tanto
 * — nunca es la única forma de resolver algo.
 */
export interface BotonesActivosMensaje {
  chatId: number;
  messageId: number;
  texto: string;
  botones: InlineKeyboardButton[][];
  actualizadoEn: number;
}

const activos = new Map<string, BotonesActivosMensaje>();

function clave(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

// Mismo criterio que el resto del sistema para "algo esperando resolución" (ver
// UMBRAL_ACTIVO_ESTANCADO_MS en revisarCorreoNuevo.ts) — pasado este tiempo, se asume que ya se
// resolvió por otro camino (Telegram) o quedó obsoleto, y deja de mostrarse en el chat web.
const TTL_MS = 48 * 60 * 60 * 1000;
const MAX_POR_CHAT = 20;

function purgarVencidosYExceso(chatId: number): void {
  const ahora = Date.now();
  const deEsteChat: [string, BotonesActivosMensaje][] = [];

  for (const [k, v] of activos) {
    if (v.chatId !== chatId) continue;
    if (ahora - v.actualizadoEn >= TTL_MS) {
      activos.delete(k);
      continue;
    }
    deEsteChat.push([k, v]);
  }

  if (deEsteChat.length <= MAX_POR_CHAT) return;
  deEsteChat.sort((a, b) => a[1].actualizadoEn - b[1].actualizadoEn);
  for (let i = 0; i < deEsteChat.length - MAX_POR_CHAT; i++) activos.delete(deEsteChat[i][0]);
}

/** Se llama al enviar un mensaje nuevo con botones (sendTelegramMessageWithButtons/Expandable). */
export function registrarBotonesActivos(chatId: number, messageId: number, texto: string, botones: InlineKeyboardButton[][]): void {
  if (botones.length === 0) return;
  activos.set(clave(chatId, messageId), { chatId, messageId, texto, botones, actualizadoEn: Date.now() });
  purgarVencidosYExceso(chatId);
}

/**
 * Se llama al repintar los botones de un mensaje ya enviado (editTelegramMessageReplyMarkup) — con
 * botones=[] (el caso más común, "ya se resolvió") lo retira del espejo; con una selección nueva
 * (ej. togglear un check) actualiza qué botones mostrar, conservando el texto original.
 */
export function actualizarBotonesActivos(chatId: number, messageId: number, botones: InlineKeyboardButton[][]): void {
  const k = clave(chatId, messageId);
  if (botones.length === 0) {
    activos.delete(k);
    return;
  }
  const existente = activos.get(k);
  if (!existente) return; // nunca se vio crear este mensaje (ej. de antes de este cambio) — nada que mostrar
  activos.set(k, { ...existente, botones, actualizadoEn: Date.now() });
}

/** Todos los mensajes con botones todavía activos para un chat, del más viejo al más nuevo. */
export function obtenerBotonesActivos(chatId: number): BotonesActivosMensaje[] {
  purgarVencidosYExceso(chatId);
  return Array.from(activos.values())
    .filter((v) => v.chatId === chatId)
    .sort((a, b) => a.actualizadoEn - b.actualizadoEn);
}

/** Un mensaje puntual — usado para validar que el botón que se intenta pulsar sigue vigente antes de despacharlo. */
export function obtenerBotonesDeMensaje(chatId: number, messageId: number): BotonesActivosMensaje | undefined {
  return activos.get(clave(chatId, messageId));
}
