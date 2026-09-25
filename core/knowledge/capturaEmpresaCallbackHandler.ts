import { retirarPreguntaCaducada } from "../telegram/preguntaCaducada";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { registrarCaptura } from "./capturaSheet";
import {
  guardarPendienteCapturaEmpresa,
  obtenerPendienteCapturaEmpresa,
  consumirPendienteCapturaEmpresa,
  cancelarPendienteCapturaEmpresa,
  reclamarPendienteCapturaParaConfirmar,
  marcarPendienteCapturaRegistrada,
  restaurarPendienteCapturaEmpresa,
  actualizarEmpresasPendienteCaptura,
  identidadCorreoDeCaptura,
  type EmpresaCaptura,
  type PendienteCapturaEmpresa,
} from "./pendienteCapturaEmpresaStore";
import type { TelegramCallbackQuery } from "../telegram/types";
import type { InlineKeyboardButton } from "../telegram/types";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import type { IdentidadCorreoCola } from "../gmail/colaRevisionStore";

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

async function avanzarCapturaDeCorreoSiCorresponde(pendiente: PendienteCapturaEmpresa): Promise<boolean> {
  if (!pendiente.deColaCorreo) return true;
  const identidad = identidadCorreoDeCaptura(pendiente);
  if (!identidad) {
    // Una captura histórica sin identidad jamás debe cerrar por accidente el
    // correo que esté activo ahora.
    console.error("[capturaEmpresaCallbackHandler] Captura de correo sin identidad; no se avanza la cola.");
    return false;
  }
  return avanzarColaCorreoSiActivo(
    pendiente.chatId,
    identidad,
    `captura-cola:${pendiente.idempotencyKey ?? `${pendiente.chatId}:${pendiente.messageId}`}`
  );
}

/**
 * Envía el mensaje con los botones de selección de empresa y guarda el
 * pendiente correspondiente — el guardado real (registrarCaptura) ocurre
 * recién al presionar "✅ Confirmar y guardar" (ver handleCapturaEmpresaCallback),
 * nunca antes. Se llama justo después de detectar un mensaje CAPTURA de
 * texto/caption normal (no el flujo de lectura de correo, que se resuelve
 * solo vía Claude).
 *
 * `mensajeIntro` es opcional: para un CAPTURA manual (la persona acaba de
 * escribir o mandar exactamente lo que se va a guardar) no hace falta,
 * pero para una propuesta AUTOMÁTICA (ver revisarCorreoNuevo.ts, correos
 * informativos que Claude marca como "vale la pena guardar") hay que
 * decirle a la persona QUÉ se propone guardar y por qué, porque ella nunca
 * pidió esto explícitamente.
 */
export async function iniciarSeleccionEmpresaCaptura(
  chatId: number,
  texto: string,
  autor?: string,
  mensajeIntro?: string,
  // true marca que esta captura pertenece al correo activo de la cola de
  // revisión uno a uno, para que confirmar/cancelar la avance (ver
  // deColaCorreo en pendienteCapturaEmpresaStore.ts). Lo pasan: el camino
  // de correo sin adjunto en core/jobs/revisarCorreoNuevo.ts, el botón
  // "🧠 Guardar como conocimiento" de un correo (emailCallbackHandler.ts,
  // siempre true — solo se crea desde la cola) y el mismo botón sobre un
  // documento adjunto (documentCallbackHandler.ts, condicional según de
  // dónde vino el documento) — comentario corregido en la auditoría, antes
  // decía "solo" un único lugar y ya no era cierto.
  deColaCorreo?: boolean,
  identidadCorreo?: IdentidadCorreoCola
): Promise<void> {
  const pregunta = mensajeIntro ? `${mensajeIntro}\n\n${mensajePregunta()}` : mensajePregunta();
  const messageId = await sendTelegramMessageWithButtons(chatId, pregunta, construirTeclado([]));
  await guardarPendienteCapturaEmpresa({
    chatId,
    messageId,
    texto,
    autor,
    empresasSeleccionadas: [],
    deColaCorreo,
    threadId: identidadCorreo?.threadId,
    mensajeId: identidadCorreo?.mensajeId,
  });
}

export async function handleCapturaEmpresaCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  if (!data || !chatId || !messageId) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const pendiente = await obtenerPendienteCapturaEmpresa(chatId, messageId);
  if (!pendiente) {
    await retirarPreguntaCaducada(callback, "Esta selección ya no está disponible (expiró o ya fue procesada).");
    return;
  }

  if (data === "capturaempresa_cancelar") {
    const reclamada = await cancelarPendienteCapturaEmpresa(chatId, messageId);
    if (!reclamada) {
      await answerCallbackQuerySafe(callback.id, "Esta captura ya se está guardando o fue procesada; no se puede cancelar.");
      return;
    }
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(chatId, reclamada.messageId, "❌ Captura descartada — no se guardó nada.", []).catch(
      (error) => console.error("[capturaEmpresaCallbackHandler] No se pudo reflejar la cancelación en Telegram (no crítico):", error)
    );
    await avanzarCapturaDeCorreoSiCorresponde(reclamada);
    return;
  }

  if (data === "capturaempresa_confirmar") {
    if (pendiente.empresasSeleccionadas.length === 0) {
      await answerCallbackQuerySafe(callback.id, "Selecciona al menos una empresa antes de confirmar.");
      return;
    }

    const claim = await reclamarPendienteCapturaParaConfirmar(chatId, messageId);
    if (claim.estado === "ausente") {
      await retirarPreguntaCaducada(callback, "Esta selección ya fue procesada.");
      return;
    }
    if (claim.estado === "en_proceso") {
      await answerCallbackQuerySafe(callback.id, "Esta captura ya se está guardando. Espera un momento antes de reintentar.");
      return;
    }
    let reclamada = claim.pendiente;

    await answerCallbackQuerySafe(callback.id, claim.estado === "registrada" ? "Confirmando cierre..." : "Guardando...");

    // El guardado es lo único que de verdad importa acá — solo se elimina el
    // pendiente y se confirma al usuario DESPUÉS de que registrarCaptura
    // termine sin lanzar error. Si falla, el pendiente se deja intacto para
    // poder reintentar con los mismos botones, y se avisa explícitamente en
    // vez de decir "guardado" sobre algo que no se guardó.
    try {
      if (claim.estado !== "registrada") {
        await registrarCaptura(
          reclamada.texto,
          reclamada.autor,
          reclamada.empresasSeleccionadas,
          reclamada.idempotencyKey
        );
        const registrada = await marcarPendienteCapturaRegistrada(reclamada);
        if (!registrada) {
          throw new Error("La captura se guardó, pero no pude confirmar su estado durable.");
        }
        reclamada = registrada;
      }

      const cierreConfirmado = await avanzarCapturaDeCorreoSiCorresponde(reclamada);
      if (!cierreConfirmado) {
        await editTelegramMessage(
          chatId,
          reclamada.messageId,
          `✅ El conocimiento ya quedó guardado — ${reclamada.empresasSeleccionadas.join(", ")}.\n\n` +
            "⚠️ Aún no pude confirmar el cierre del correo. Vuelve a pulsar el botón; no se duplicará la captura.",
          [[{ text: "🔄 Confirmar cierre del correo", callback_data: "capturaempresa_confirmar" }]]
        ).catch((error) =>
          console.error("[capturaEmpresaCallbackHandler] No se pudo mostrar el reintento de cierre (no crítico):", error)
        );
        return;
      }

      await consumirPendienteCapturaEmpresa(chatId, messageId);
      await editTelegramMessage(
        chatId,
        reclamada.messageId,
        `✅ Guardado — ${reclamada.empresasSeleccionadas.join(", ")}.`,
        []
      ).catch((error) =>
        console.error("[capturaEmpresaCallbackHandler] No se pudo reflejar el guardado en Telegram (no crítico):", error)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error guardando captura de conocimiento:", message);
      try {
        await restaurarPendienteCapturaEmpresa(reclamada);
      } catch (errorRestaurando) {
        const detalle = errorRestaurando instanceof Error ? errorRestaurando.message : String(errorRestaurando);
        console.error("[capturaEmpresaCallbackHandler] No se pudo restaurar la captura tras el fallo:", detalle);
        await editTelegramMessage(
          chatId,
          reclamada.messageId,
          `❌ No se pudo guardar la captura (error: ${message}) y tampoco pude restaurar la selección (${detalle}). ` +
            "El correo sigue sin leer; vuelve a iniciar Guardar como conocimiento.",
          []
        ).catch(() => {});
        return;
      }
      await editTelegramMessage(
        chatId,
        reclamada.messageId,
        `❌ No se pudo guardar la captura (error: ${message}). La selección de empresa se mantiene — puedes ` +
          "volver a presionar Confirmar para reintentar, o escribir el CAPTURA de nuevo.",
        construirTeclado(reclamada.empresasSeleccionadas)
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

    const actualizada = await actualizarEmpresasPendienteCaptura(chatId, messageId, seleccionadas);
    if (!actualizada) {
      await retirarPreguntaCaducada(callback, "Esta selección ya fue procesada.");
      return;
    }
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(chatId, actualizada.messageId, mensajePregunta(), construirTeclado(actualizada.empresasSeleccionadas));
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}
