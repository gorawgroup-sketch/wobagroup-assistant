import { createHash } from "node:crypto";
import { enviarCorreo } from "../gmail/client";
import { answerCallbackQuery, editTelegramMessage, sendTelegramDocument, sendTelegramMessage } from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { conMutex } from "../utils/asyncMutex";
import type { Empresa } from "../holded/client";
import { esTitularEmpresa } from "./cruceExtracto";
import { mostrarResumen, textoResumen } from "./campanaSoportes";
import { actualizarPersona, leerCampana, mutexCampana, type PersonaCampana } from "./campanaSoportesStore";
import { generarSeguimientoXlsx, nombreArchivoSeguimiento, redactarCorreoSoportesHtml } from "./correoSoportesHtml";
import { asuntoCorreoSoportes, redactarCorreoSoportes } from "./redactarCorreoSoportes";
import { registrarSolicitud } from "./solicitudesSoportesSheet";
import { resolverEmailCompleto } from "./emailTitular";
import { registrarEmailTitular } from "./titularesSoportesSheet";

/**
 * Botones del resumen de soportes: casilla por persona (sop_t), ver el correo (sop_v), refrescar emails (sop_a),
 * enviar (sop_e) y cancelar (sop_c). Todos los datos viven en la campaña durable; el botón solo lleva su id.
 * El envío usa una clave de idempotencia por campaña+persona+destinatario: un doble toque o un reintento tras un corte
 * nunca manda dos correos a la misma persona.
 */

async function responder(id: string, texto?: string): Promise<void> {
  try { await answerCallbackQuery(id, texto); } catch (error) {
    console.error("[soportes] No se pudo responder al botón (no crítico):", error instanceof Error ? error.message : error);
  }
}

const PENDIENTES = ["pendiente", "enviando", "fallido"];
const hashCorto = (t: string): string => createHash("sha1").update(t.toLowerCase()).digest("hex").slice(0, 8);

const datosCorreo = (p: PersonaCampana) => ({ titular: p.titular, empresa: p.empresa, desde: p.desde, hasta: p.hasta, cargos: p.cargos, yaSolicitados: p.yaSolicitados });
export const cuerpoDe = (p: PersonaCampana): string => redactarCorreoSoportes(datosCorreo(p));

export async function handleSoportesCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  const [accion, id, indiceTexto] = (callback.data ?? "").split(":");
  if (!chatId || !id) { await responder(callback.id, "Petición no válida."); return; }

  await conMutex(mutexCampana(id), async () => {
    const personas = await leerCampana(id);
    if (personas.length === 0) {
      await responder(callback.id, "Esta campaña ya no está disponible.");
      return;
    }
    const indice = Number(indiceTexto);
    const persona = Number.isInteger(indice) ? personas.find((p) => p.indice === indice) : undefined;
    const refrescar = async () => mostrarResumen(await leerCampana(id));

    if (accion === "sop_t") {
      if (!persona || !persona.email || !PENDIENTES.includes(persona.estado)) { await responder(callback.id, "Esta persona ya no se puede cambiar."); return; }
      await actualizarPersona(persona, { seleccionado: !persona.seleccionado });
      await responder(callback.id);
      await refrescar();
      return;
    }

    if (accion === "sop_v") {
      if (!persona || !persona.email) { await responder(callback.id, "Falta el email de esta persona."); return; }
      await responder(callback.id);
      await sendTelegramMessage(chatId, [`✉️ Para: ${persona.email}`, `Asunto: ${asuntoCorreoSoportes(persona)}`, "", cuerpoDe(persona)].join("\n"));
      // Así lo verá quien lo recibe: el cuerpo con su cuadro (se abre en el navegador) y la hoja de seguimiento adjunta.
      const d = datosCorreo(persona);
      await sendTelegramDocument(chatId, Buffer.from(`<!doctype html><meta charset="utf-8"><title>${asuntoCorreoSoportes(persona)}</title><body style="margin:20px">${redactarCorreoSoportesHtml(d)}</body>`, "utf-8"), `Vista_correo_${persona.titular.split(/\s+/)[0]}.html`, "Cómo se ve el correo con su cuadro (ábrelo en el navegador).");
      await sendTelegramDocument(chatId, await generarSeguimientoXlsx(d), nombreArchivoSeguimiento(d), "Hoja de seguimiento que va adjunta al correo.");
      return;
    }

    if (accion === "sop_a") {
      let cambios = 0;
      for (const p of personas) {
        if (!PENDIENTES.includes(p.estado) || p.titular === "(sin titular)") continue;
        if (esTitularEmpresa(p.titular)) continue;
        const r = await resolverEmailCompleto(p.titular, p.empresa as Empresa);
        if (r.tipo === "resuelto" && (r.email !== p.email || r.fuente !== p.fuenteEmail)) {
          await actualizarPersona(p, { email: r.email, fuenteEmail: r.fuente, sugerencias: "", seleccionado: r.fuente === "confirmado" ? true : p.seleccionado && r.email === p.email });
          cambios++;
        } else if ((r.tipo === "varios" || r.tipo === "sugerencias") && !p.email && r.candidatos.join(", ") !== p.sugerencias) {
          await actualizarPersona(p, { sugerencias: r.candidatos.join(", ") });
          cambios++;
        }
      }
      await responder(callback.id, cambios ? `Actualicé ${cambios} email(s).` : "No hay emails nuevos.");
      if (cambios) await refrescar();
      return;
    }

    if (accion === "sop_m") {
      for (const p of personas) if (p.email && !p.seleccionado && ["pendiente", "fallido"].includes(p.estado)) await actualizarPersona(p, { seleccionado: true });
      await responder(callback.id, "Marcados.");
      await refrescar();
      return;
    }

    if (accion === "sop_c") {
      for (const p of personas) if (PENDIENTES.includes(p.estado)) await actualizarPersona(p, { estado: "omitido", seleccionado: false });
      await responder(callback.id, "Campaña cancelada.");
      const finales = await leerCampana(id);
      await editTelegramMessage(chatId, finales[0].messageId, `❌ Campaña cancelada: no se envió nada más.\n\n${textoResumen(finales)}`, []);
      return;
    }

    if (accion === "sop_e") {
      const aEnviar = personas.filter((p) => p.seleccionado && p.email && PENDIENTES.includes(p.estado));
      if (aEnviar.length === 0) { await responder(callback.id, "Marca al menos a una persona con email."); return; }
      await responder(callback.id, `Enviando ${aEnviar.length} correo(s)...`);
      const fallos: string[] = [];
      for (const p of aEnviar) {
        const actual = await actualizarPersona(p, { estado: "enviando" });
        try {
          await enviarCorreo({
            to: p.email,
            asunto: asuntoCorreoSoportes(p),
            cuerpo: cuerpoDe(p),
            cuerpoHtml: redactarCorreoSoportesHtml(datosCorreo(p)),
            adjuntos: [{ filename: nombreArchivoSeguimiento(datosCorreo(p)), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: await generarSeguimientoXlsx(datosCorreo(p)) }],
            idempotencyKey: `soportes:${id}:${p.indice}:${hashCorto(p.email)}`,
            proceso: "soportes_titular",
          });
          await actualizarPersona(actual, { estado: "enviado" });
          // Enviar a esa dirección la confirma: queda guardada para las semanas siguientes (y se marcará sola).
          await registrarEmailTitular(p.titular, p.email).catch((error) =>
            console.error("[soportes] No se pudo guardar el email confirmado (no crítico):", error instanceof Error ? error.message : error));
          try {
            await registrarSolicitud(p.empresa, p.titular, id, p.cargos.map((c) => c.id), Date.now());
          } catch (error) {
            // El correo ya salió: no se deshace. Solo se pierde el aviso anti-repetición de la semana próxima.
            console.error("[soportes] Correo enviado pero no se pudo registrar la solicitud:", error instanceof Error ? error.message : error);
          }
        } catch (error) {
          console.error(`[soportes] Error enviando a ${p.email}:`, error instanceof Error ? error.message : error);
          await actualizarPersona(actual, { estado: "fallido" });
          fallos.push(p.titular);
        }
      }
      const finales = await leerCampana(id);
      const enviados = finales.filter((p) => p.estado === "enviado").length;
      await mostrarResumen(finales);
      await sendTelegramMessage(chatId, fallos.length
        ? `📤 Envié ${aEnviar.length - fallos.length} de ${aEnviar.length} correos. Falló: ${fallos.join(", ")}. Pulsa «Enviar» otra vez para reintentar solo esos.`
        : `📤 Listo: ${enviados} ${enviados === 1 ? "correo enviado" : "correos enviados"} desde asistente@wobagroup.com. Cuando respondan, los soportes entran por el flujo de correo normal y se concilian ahí.`);
      return;
    }

    await responder(callback.id, "Acción desconocida.");
  });
}
