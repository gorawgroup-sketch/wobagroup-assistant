import { createHash, randomUUID } from "node:crypto";
import { enviarCorreo } from "../gmail/client";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { conMutex } from "../utils/asyncMutex";
import { resolverAudiencia } from "./audiencias";
import { aplicarExclusiones, type Destinatario } from "./destinatarios";
import { actualizarDestinatario, crearComunicacion, enviosPrevios, fijarMensaje, leerComunicacion, mutexComunicacion, type DestinatarioGuardado } from "./envioMasivoStore";
import { marcasDesconocidas, renderizar } from "./plantilla";
import { BUZON_SOPORTES } from "../soportes/redactarCorreoSoportes";

/**
 * Correo a una audiencia: resumen con tres botones — «Ver correo» (cm_v), «Enviar» (cm_e, solo superadmin) y «Cancelar» (cm_c). El texto lo
 * redacta el chat siguiendo la orden de quien lo pide; aquí se valida, se muestra tal como saldrá y se envía SOLO al pulsar «Enviar», con una
 * clave de idempotencia por comunicación+persona+destinatario: un doble toque o un reintento tras un corte nunca manda dos correos a la misma persona.
 */
export const MAX_DESTINATARIOS = 60;
const PENDIENTES = ["pendiente", "enviando", "fallido"];
const hashCorto = (t: string): string => createHash("sha1").update(t.toLowerCase()).digest("hex").slice(0, 8);

async function responder(id: string, texto?: string): Promise<void> {
  try { await answerCallbackQuery(id, texto); } catch (error) {
    console.error("[comunicaciones] No se pudo responder al botón (no crítico):", error instanceof Error ? error.message : error);
  }
}

export interface PeticionEnvio {
  audiencia: string;
  parametros?: Record<string, unknown>;
  asunto: string;
  cuerpo: string;
  excluir?: string[];
  /** Una frase de qué es este envío (para el resumen y el registro). */
  descripcion?: string;
}

const estadoIcono = (e: string): string => ({ enviado: "✅", fallido: "⚠️", omitido: "➖", enviando: "⏳", pendiente: "☐" } as Record<string, string>)[e] ?? "☐";

export function textoResumen(c: { asunto: string; descripcion: string }, personas: Array<Pick<DestinatarioGuardado, "nombre" | "email" | "empresas" | "estado">>, extra: { sinEmail?: string[]; omitidos?: string[]; excluidos?: string[]; yaEnviado?: string[] } = {}): string {
  return [
    `📣 Correo a una audiencia — ${c.descripcion || "sin descripción"}`,
    `Asunto: ${c.asunto}`,
    `Para ${personas.length} ${personas.length === 1 ? "persona" : "personas"}:`,
    ...personas.map((d) => `${estadoIcono(d.estado)} ${d.nombre}${d.empresas.length ? ` (${d.empresas.join(", ")})` : ""} — ${d.email}`),
    ...(extra.yaEnviado?.length ? ["", `⚠️ A estas personas ya se les envió un correo con este mismo asunto en los últimos 30 días: ${extra.yaEnviado.join(", ")}.`] : []),
    ...(extra.sinEmail?.length ? ["", `Sin email que consta (no se les escribe): ${extra.sinEmail.join(", ")}.`] : []),
    ...(extra.omitidos?.length ? ["", `Omitidos (no son personas a las que escribir): ${extra.omitidos.join(", ")}.`] : []),
    ...(extra.excluidos?.length ? ["", `Excluidos a petición: ${extra.excluidos.join(", ")}.`] : []),
    "",
    "Nada sale hasta que pulses «Enviar». «Ver correo» muestra el texto exacto con los datos de la primera persona.",
  ].join("\n");
}

/** Valida, resuelve la audiencia y devuelve lo que se mostraría; no guarda ni envía nada. */
export async function resolverPeticion(p: PeticionEnvio): Promise<{ error?: string; destinatarios: Destinatario[]; sinEmail: string[]; omitidos: string[]; excluidos: string[] }> {
  const vacio = { destinatarios: [] as Destinatario[], sinEmail: [] as string[], omitidos: [] as string[], excluidos: [] as string[] };
  const asunto = p.asunto.trim(), cuerpo = p.cuerpo.trim();
  if (!asunto || cuerpo.length < 20) return { ...vacio, error: "Faltan el asunto o el cuerpo del correo (el cuerpo es demasiado corto)." };
  const desconocidas = marcasDesconocidas(`${asunto}\n${cuerpo}`);
  if (desconocidas.length) return { ...vacio, error: `El texto usa marcas que no existen: ${desconocidas.map((m) => `{${m}}`).join(", ")}. Solo valen {nombre}, {nombre_completo} y {empresas}.` };
  const r = await resolverAudiencia(p.audiencia, p.parametros ?? {});
  // El propio buzón de Wobi nunca es destinatario (aparece en el directorio de contactos).
  const { quedan, excluidos } = aplicarExclusiones(r.destinatarios.filter((d) => d.email !== BUZON_SOPORTES), p.excluir ?? []);
  if (quedan.length > MAX_DESTINATARIOS) return { ...vacio, error: `La audiencia tiene ${quedan.length} personas; el máximo por envío es ${MAX_DESTINATARIOS}. Acótala (por empresa, por dominio o con una consulta).` };
  return { destinatarios: quedan, sinEmail: r.sinEmail, omitidos: r.omitidos, excluidos };
}

/** Texto para quien lo pidió: a quién iría, sin guardar ni mostrar nada en Telegram. */
export async function listarPeticion(p: PeticionEnvio): Promise<string> {
  const r = await resolverPeticion(p);
  if (r.error) return `Error: ${r.error}`;
  return textoResumen({ asunto: p.asunto, descripcion: p.descripcion ?? "" }, r.destinatarios.map((d) => ({ ...d, estado: "pendiente" as const })), r) + "\n\n(Solo consulta: no se preparó ningún envío.)";
}

/** Prepara el envío y lo muestra con sus botones; no envía nada. Devuelve el texto para quien lo pidió (herramienta del chat). */
export async function prepararEnvioMasivo(chatId: number, p: PeticionEnvio): Promise<string> {
  const r = await resolverPeticion(p);
  if (r.error) return `Error: ${r.error}`;
  if (r.destinatarios.length === 0) {
    return `La audiencia «${p.audiencia}» no tiene ninguna persona con email que consta${r.sinEmail.length ? ` (sin email: ${r.sinEmail.join(", ")})` : ""}. Dime el correo de cada una y vuelvo a prepararlo.`;
  }
  const yaEnviado = await enviosPrevios(p.asunto.trim(), r.destinatarios.map((d) => d.email)).catch(() => [] as string[]);
  const id = randomUUID().slice(0, 8), ahora = Date.now();
  const cabecera = { id, chatId, messageId: 0, descripcion: (p.descripcion ?? `Audiencia ${p.audiencia}`).trim().slice(0, 200), asunto: p.asunto.trim(), cuerpo: p.cuerpo.trim(), creadoEn: ahora };
  await crearComunicacion(cabecera, r.destinatarios.map((d, indice) => ({ indice, nombre: d.nombre, email: d.email, empresas: d.empresas, estado: "pendiente" as const, ...(d.detalle ? { detalle: d.detalle } : {}) })));
  const messageId = await sendTelegramMessageWithButtons(chatId, textoResumen(cabecera, r.destinatarios.map((d) => ({ ...d, estado: "pendiente" as const })), { ...r, yaEnviado }), [
    [{ text: "👁 Ver correo", callback_data: `cm_v:${id}` }],
    [{ text: `✅ Enviar a ${r.destinatarios.length}`, callback_data: `cm_e:${id}` }, { text: "❌ Cancelar", callback_data: `cm_c:${id}` }],
  ]);
  await fijarMensaje(id, messageId);
  return `Preparé el correo para ${r.destinatarios.length} ${r.destinatarios.length === 1 ? "persona" : "personas"} y lo mostré en el chat con sus botones; no se envió nada todavía.`;
}

export async function handleEnvioMasivoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  const [accion, id] = (callback.data ?? "").split(":");
  if (!chatId || !id) { await responder(callback.id, "Petición no válida."); return; }

  await conMutex(mutexComunicacion(id), async () => {
    const com = await leerComunicacion(id);
    if (!com || com.destinatarios.length === 0) { await responder(callback.id, "Este correo ya no está disponible."); return; }
    const { cabecera, destinatarios } = com;
    const render = (d: DestinatarioGuardado) => ({ asunto: renderizar(cabecera.asunto, d), cuerpo: renderizar(cabecera.cuerpo, d) });

    if (accion === "cm_v") {
      await responder(callback.id);
      const primera = destinatarios[0], r = render(primera);
      await sendTelegramMessage(chatId, [`✉️ Asunto: ${r.asunto}`, `Ejemplo para ${primera.nombre} (${primera.email}):`, "", r.cuerpo].join("\n"));
      return;
    }

    if (accion === "cm_c") {
      for (const d of destinatarios) if (PENDIENTES.includes(d.estado)) await actualizarDestinatario(d, "omitido");
      await responder(callback.id, "Envío cancelado.");
      const finales = (await leerComunicacion(id))?.destinatarios ?? [];
      await editTelegramMessage(chatId, cabecera.messageId, `❌ Cancelado: no se envió nada más.\n\n${textoResumen(cabecera, finales)}`, []);
      return;
    }

    if (accion === "cm_e") {
      const aEnviar = destinatarios.filter((d) => PENDIENTES.includes(d.estado));
      if (aEnviar.length === 0) { await responder(callback.id, "No queda nadie por enviar."); return; }
      await responder(callback.id, `Enviando ${aEnviar.length} correo(s)...`);
      const fallos: string[] = [];
      for (const d of aEnviar) {
        const actual = await actualizarDestinatario(d, "enviando");
        try {
          const r = render(d);
          await enviarCorreo({ to: d.email, asunto: r.asunto, cuerpo: r.cuerpo, idempotencyKey: `comunicacion:${id}:${d.indice}:${hashCorto(d.email)}`, proceso: "correo_a_audiencia" });
          await actualizarDestinatario(actual, "enviado");
        } catch (error) {
          console.error(`[comunicaciones] Error enviando a ${d.email}:`, error instanceof Error ? error.message : error);
          await actualizarDestinatario(actual, "fallido");
          fallos.push(d.nombre);
        }
      }
      const finales = (await leerComunicacion(id))?.destinatarios ?? [];
      const enviados = finales.filter((d) => d.estado === "enviado").length;
      await editTelegramMessage(chatId, cabecera.messageId, textoResumen(cabecera, finales), fallos.length ? [[{ text: "🔁 Reintentar los que fallaron", callback_data: `cm_e:${id}` }]] : []).catch((error) =>
        console.error("[comunicaciones] No se pudo actualizar el resumen (no crítico):", error instanceof Error ? error.message : error));
      await sendTelegramMessage(chatId, fallos.length
        ? `📤 Envié ${aEnviar.length - fallos.length} de ${aEnviar.length} correos. Falló: ${fallos.join(", ")}. Pulsa «Reintentar» para volver a intentar solo esos.`
        : `📤 Listo: ${enviados} ${enviados === 1 ? "correo enviado" : "correos enviados"} desde asistente@wobagroup.com.`);
      return;
    }

    await responder(callback.id, "Acción desconocida.");
  });
}
