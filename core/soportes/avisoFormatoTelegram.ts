import { createHash, randomUUID } from "node:crypto";
import { enviarCorreo } from "../gmail/client";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { conMutex } from "../utils/asyncMutex";
import { agruparDestinatarios, ASUNTO_AVISO_FORMATO, redactarAvisoFormato } from "./avisoFormato";
import { actualizarDestinatario, crearAviso, fijarMensajeAviso, leerAviso, mutexAviso, type DestinatarioGuardado } from "./avisoFormatoStore";
import { buscarHoja } from "./hojaSeguimiento";
import { leerSolicitantes } from "./solicitudesSoportesSheet";
import { resolverEmailGuardado } from "./titularesSoportesSheet";
import { BUZON_SOPORTES } from "./redactarCorreoSoportes";

/**
 * Aviso de formato de soportes (ver avisoFormato.ts): resumen con tres botones — «Ver correo» (sop_av), «Enviar» (sop_ae, solo
 * superadmin) y «Cancelar» (sop_ac). El envío lleva una clave de idempotencia por aviso+persona+destinatario: un doble toque o un reintento
 * tras un corte nunca manda dos correos a la misma persona.
 */
const PENDIENTES = ["pendiente", "enviando", "fallido"];
const hashCorto = (t: string): string => createHash("sha1").update(t.toLowerCase()).digest("hex").slice(0, 8);

async function responder(id: string, texto?: string): Promise<void> {
  try { await answerCallbackQuery(id, texto); } catch (error) {
    console.error("[soportes] No se pudo responder al botón del aviso (no crítico):", error instanceof Error ? error.message : error);
  }
}

/** La hoja de seguimiento ya existente de esa persona (de la primera empresa que la tenga); si no se puede leer, el aviso sale sin enlace. */
async function hojaDe(d: Pick<DestinatarioGuardado, "email" | "empresas">): Promise<string | undefined> {
  for (const empresa of d.empresas) {
    try { const h = await buscarHoja(empresa, d.email); if (h?.url) return h.url; } catch (error) {
      console.error(`[soportes] No se pudo leer la hoja de seguimiento de ${d.email} (${empresa}); el aviso sale sin enlace:`, error instanceof Error ? error.message : error);
    }
  }
  return undefined;
}

export const cuerpoAviso = (d: Pick<DestinatarioGuardado, "titular" | "empresas">, hojaUrl?: string): string =>
  redactarAvisoFormato({ titular: d.titular, empresas: d.empresas, ...(hojaUrl ? { hojaUrl } : {}) });

export function textoResumenAviso(personas: DestinatarioGuardado[], extra: { sinEmail?: string[]; excluidos?: string[] } = {}): string {
  const estado = (d: DestinatarioGuardado): string => ({ enviado: "✅", fallido: "⚠️", omitido: "➖", enviando: "⏳", pendiente: "☐" } as Record<string, string>)[d.estado] ?? "☐";
  const lineas = personas.map((d) => `${estado(d)} ${d.titular} (${d.empresas.join(", ")}) — ${d.email}`);
  return [
    "📣 Aviso de formato de soportes",
    `De ${BUZON_SOPORTES} a ${personas.length} ${personas.length === 1 ? "persona" : "personas"} que ya recibieron una solicitud: agradecer a quien ya envió y explicar cómo enviar cada soporte.`,
    "",
    ...lineas,
    ...(extra.sinEmail?.length ? ["", `Sin email confirmado (no se les escribe): ${extra.sinEmail.join(", ")}.`] : []),
    ...(extra.excluidos?.length ? ["", `Excluidos: ${extra.excluidos.join(", ")}.`] : []),
    "",
    `Asunto: ${ASUNTO_AVISO_FORMATO}`,
    "Nada sale hasta que pulses «Enviar». «Ver correo» muestra el texto exacto.",
  ].join("\n");
}

/** Prepara el aviso y lo muestra con sus botones; no envía nada. Devuelve el texto para quien lo pidió (herramienta del chat). */
export async function prepararAvisoFormato(chatId: number, opciones: { excluir?: string[] } = {}): Promise<string> {
  const solicitantes = await leerSolicitantes();
  if (solicitantes.length === 0) return "No hay ninguna solicitud de soportes registrada: no hay a quién avisar.";
  const { destinatarios, sinEmail, excluidos } = await agruparDestinatarios(solicitantes, resolverEmailGuardado, opciones.excluir ?? []);
  if (destinatarios.length === 0) {
    return `No hay ningún destinatario con email confirmado${sinEmail.length ? ` (sin email: ${sinEmail.join(", ")})` : ""}. Dime el correo de cada uno y vuelvo a prepararlo.`;
  }
  const aviso = randomUUID().slice(0, 8);
  const ahora = Date.now();
  await crearAviso(destinatarios.map((d, indice) => ({ aviso, indice, chatId, messageId: 0, titular: d.titular, email: d.email, empresas: d.empresas, estado: "pendiente" as const, creadoEn: ahora })));
  const personas = await leerAviso(aviso);
  const messageId = await sendTelegramMessageWithButtons(chatId, textoResumenAviso(personas, { sinEmail, excluidos }), [
    [{ text: "👁 Ver correo", callback_data: `sop_av:${aviso}` }],
    [{ text: `✅ Enviar a ${personas.length}`, callback_data: `sop_ae:${aviso}` }, { text: "❌ Cancelar", callback_data: `sop_ac:${aviso}` }],
  ]);
  await fijarMensajeAviso(aviso, messageId);
  return `Preparé el aviso de formato para ${personas.length} ${personas.length === 1 ? "persona" : "personas"} y lo mostré en el chat con sus botones; no se envió nada todavía.`;
}

export async function handleAvisoFormatoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  const [accion, id] = (callback.data ?? "").split(":");
  if (!chatId || !id) { await responder(callback.id, "Petición no válida."); return; }

  await conMutex(mutexAviso(id), async () => {
    const personas = await leerAviso(id);
    if (personas.length === 0) { await responder(callback.id, "Este aviso ya no está disponible."); return; }
    const mensaje = personas[0].messageId;

    if (accion === "sop_av") {
      await responder(callback.id);
      const primera = personas[0];
      await sendTelegramMessage(chatId, [`✉️ Asunto: ${ASUNTO_AVISO_FORMATO}`, `Ejemplo para ${primera.titular} (${primera.email}):`, "", cuerpoAviso(primera, await hojaDe(primera))].join("\n"));
      return;
    }

    if (accion === "sop_ac") {
      for (const d of personas) if (PENDIENTES.includes(d.estado)) await actualizarDestinatario(d, { estado: "omitido" });
      await responder(callback.id, "Aviso cancelado.");
      await editTelegramMessage(chatId, mensaje, `❌ Aviso cancelado: no se envió nada más.\n\n${textoResumenAviso(await leerAviso(id))}`, []);
      return;
    }

    if (accion === "sop_ae") {
      const aEnviar = personas.filter((d) => PENDIENTES.includes(d.estado));
      if (aEnviar.length === 0) { await responder(callback.id, "No queda nadie por enviar."); return; }
      await responder(callback.id, `Enviando ${aEnviar.length} correo(s)...`);
      const fallos: string[] = [];
      for (const d of aEnviar) {
        const actual = await actualizarDestinatario(d, { estado: "enviando" });
        try {
          await enviarCorreo({
            to: d.email,
            asunto: ASUNTO_AVISO_FORMATO,
            cuerpo: cuerpoAviso(d, await hojaDe(d)),
            idempotencyKey: `soportes-aviso:${id}:${d.indice}:${hashCorto(d.email)}`,
            proceso: "soportes_titular",
          });
          await actualizarDestinatario(actual, { estado: "enviado" });
        } catch (error) {
          console.error(`[soportes] Error enviando el aviso de formato a ${d.email}:`, error instanceof Error ? error.message : error);
          await actualizarDestinatario(actual, { estado: "fallido" });
          fallos.push(d.titular);
        }
      }
      const finales = await leerAviso(id);
      const enviados = finales.filter((d) => d.estado === "enviado").length;
      await editTelegramMessage(chatId, mensaje, textoResumenAviso(finales), fallos.length ? [[{ text: "🔁 Reintentar los que fallaron", callback_data: `sop_ae:${id}` }]] : []).catch((error) =>
        console.error("[soportes] No se pudo actualizar el resumen del aviso (no crítico):", error instanceof Error ? error.message : error));
      await sendTelegramMessage(chatId, fallos.length
        ? `📤 Envié ${aEnviar.length - fallos.length} de ${aEnviar.length} correos. Falló: ${fallos.join(", ")}. Pulsa «Reintentar» para volver a intentar solo esos.`
        : `📤 Listo: ${enviados} ${enviados === 1 ? "correo enviado" : "correos enviados"} desde ${BUZON_SOPORTES}.`);
      return;
    }

    await responder(callback.id, "Acción desconocida.");
  });
}
