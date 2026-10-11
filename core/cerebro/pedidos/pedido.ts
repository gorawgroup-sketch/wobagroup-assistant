import { createHash } from "node:crypto";
import { crearEntregaTelegram, type EntregaTelegramDurable } from "../../telegram/durableDelivery";
import type { TelegramUpdate } from "../../telegram/types";
import { extraerCodigoVinculoChat } from "../chatLinkCommand";

/**
 * Pedido desde «Pídele a WOBi»: lo que la persona escribe en el front y CONFIRMA, convertido en un update sintético que entra por el
 * mismo procesamiento que un mensaje de Telegram de esa misma persona (misma identidad, mismos permisos, mismas aprobaciones).
 * Funciones puras: identificadores deterministas, validación del texto, update sintético y traducción del estado de la entrega durable.
 */
export const MAX_TEXTO_PEDIDO = 4_000;
export const PEDIDO_ID = /^[A-Za-z0-9_-]{16,64}$/;

export type EstadoPedido = "pendiente_confirmacion" | "recibido" | "procesando" | "terminado" | "fallido" | "cancelado" | "expirado";
export type EjecucionPedido = "no_enviada" | "pendiente" | "en_curso" | "finalizada" | "incierta" | "descartada";

const sha = (valor: string): string => createHash("sha256").update(valor).digest("hex");
export const hashTextoPedido = (texto: string): string => sha(texto);

/** Referencia corta y legible que se ve en Telegram junto al eco del pedido; sirve para localizar su respuesta en el historial. */
export const refDePedido = (chatId: number, pedidoId: string): string => sha(`pedido:${chatId}:${pedidoId}`).slice(0, 8).toUpperCase();

/**
 * `update_id` sintético: NEGATIVO (Telegram solo emite positivos, así que jamás choca con uno real) y determinista por persona + pedido.
 * Es la clave de idempotencia del ledger durable: confirmar dos veces el mismo pedido es siempre la misma entrega.
 */
export const updateIdDePedido = (chatId: number, pedidoId: string): number =>
  -(Number.parseInt(sha(`pedido-update:${chatId}:${pedidoId}`).slice(0, 12), 16) + 1);

export const claveEntregaDePedido = (chatId: number, pedidoId: string): string =>
  crearEntregaTelegram({ update_id: updateIdDePedido(chatId, pedidoId) }, false).clave;

export const huellaDispositivo = (deviceId: string): string => sha(`dispositivo:${deviceId}`).slice(0, 12);

export type ValidacionTexto = { ok: true } | { ok: false; codigo: "texto_invalido" | "texto_no_permitido"; mensaje: string };

/**
 * El texto debe ser lo que la persona escribió, tal cual. Se rechaza lo que no puede ser una petición en lenguaje natural y lo que
 * tocaría la identidad: un código de vinculación enviado como pedido permitiría enlazar OTRO dispositivo sin pasar por el Telegram
 * de la persona, que es justo lo que la vinculación garantiza.
 */
export function validarTextoPedido(texto: unknown): ValidacionTexto {
  if (typeof texto !== "string" || texto.trim().length === 0 || texto.length > MAX_TEXTO_PEDIDO) {
    return { ok: false, codigo: "texto_invalido", mensaje: `El pedido debe tener entre 1 y ${MAX_TEXTO_PEDIDO} caracteres.` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(texto)) {
    return { ok: false, codigo: "texto_invalido", mensaje: "El pedido contiene caracteres de control que no se pueden enviar." };
  }
  if (extraerCodigoVinculoChat(texto) !== undefined || /^\s*\/?(?:vincular|start)\b/i.test(texto)) {
    return { ok: false, codigo: "texto_no_permitido", mensaje: "La vinculación de dispositivos solo se puede hacer escribiendo el código en tu propio Telegram, no desde un pedido." };
  }
  return { ok: true };
}

export interface DatosUpdatePedido {
  chatId: number;
  nombre: string;
  texto: string;
  pedidoId: string;
  dispositivo: string;
  ahoraMs: number;
}

export function construirUpdateDePedido(d: DatosUpdatePedido): TelegramUpdate {
  const updateId = updateIdDePedido(d.chatId, d.pedidoId);
  return {
    update_id: updateId,
    message: {
      message_id: (Math.abs(updateId) % 2_000_000_000) + 1,
      from: { id: d.chatId, is_bot: false, first_name: d.nombre },
      chat: { id: d.chatId, type: "private" },
      date: Math.floor(d.ahoraMs / 1000),
      text: d.texto,
    },
    origen: { canal: "front", pedidoId: d.pedidoId, ref: refDePedido(d.chatId, d.pedidoId), dispositivo: d.dispositivo, textoHash: hashTextoPedido(d.texto) },
  };
}

export const MAX_ECO = 300;
/** Lo que se ve en el chat de Telegram para que la respuesta del bot tenga contexto (el mensaje de la persona no existe allí). */
export function textoEcoPedido(ref: string, texto: string): string {
  const visible = texto.length > MAX_ECO ? `${texto.slice(0, MAX_ECO)}…` : texto;
  return `📲 Pedido desde el front (ref. ${ref}): «${visible}»`;
}

export interface VistaEstadoPedido {
  estado: EstadoPedido;
  /** Qué ha pasado con la ejecución, separado de la recepción. */
  ejecucion: EjecucionPedido;
  detalle?: "resultado_incierto";
  mensaje: string;
}

const AVISO_APROBACIONES = "«Terminado» no significa que una operación se haya aprobado o ejecutado: toda operación financiera o sensible sigue esperando tu aprobación en Telegram.";

/** Traduce el estado de la entrega durable de Telegram al vocabulario del front. */
export function vistaDeEntrega(entrega: Pick<EntregaTelegramDurable, "estado">): VistaEstadoPedido {
  switch (entrega.estado) {
    case "reservada":
      return { estado: "recibido", ejecucion: "pendiente", mensaje: "WOBi recibió tu pedido y quedó registrado. Todavía no ha empezado a procesarlo." };
    case "iniciada":
      return { estado: "procesando", ejecucion: "en_curso", mensaje: "WOBi está procesando tu pedido. La respuesta llegará a tu chat de Telegram." };
    case "completada":
      return { estado: "terminado", ejecucion: "finalizada", mensaje: `WOBi terminó de procesar tu pedido; la respuesta está en tu chat de Telegram. ${AVISO_APROBACIONES}` };
    default:
      return { estado: "fallido", ejecucion: "incierta", detalle: "resultado_incierto",
        mensaje: "El procesamiento se interrumpió y no se puede asegurar qué llegó a hacerse. No se repite solo: revisa tu chat de Telegram (te avisa con «Verificar resultado») antes de volver a pedirlo." };
  }
}
