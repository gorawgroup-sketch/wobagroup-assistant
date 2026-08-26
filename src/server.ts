import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import { parseIncomingUpdate, sendTelegramMessage, answerCallbackQuery } from "../core/telegram/client";
import { esUsuarioAutorizado, esAccionSensible, obtenerRolUsuario } from "../core/telegram/authorizedUsersSheet";
import { notificarSolicitudAcceso, handleAuthCallback } from "../core/telegram/adminNotify";
import { handleCallbackQuery } from "../core/telegram/callbackHandler";
import { handleIncomingFile } from "../core/documental/receiveFile";
import { handleDocumentCallback } from "../core/documental/documentCallbackHandler";
import { consumirPendienteDesambiguacion } from "../core/documental/disambiguationStore";
import { manejarClasificacion } from "../core/documental/processClassification";
import { esMensajeCaptura, guardarCaptura } from "../core/knowledge/capture";
import { askClaude } from "../core/claude/client";
import { startScheduler } from "../core/jobs/scheduler";
import { revisarHoldedVsCashflow } from "../core/jobs/revisarHoldedVsCashflow";
import { revisarAlertasFiscales } from "../core/jobs/revisarAlertasFiscales";
import { revisarCorreoNuevo } from "../core/jobs/revisarCorreoNuevo";
import { handleEmailActionCallback, continuarConOrientacion, handleDraftCallback, continuarConEdicionBorrador } from "../core/gmail/emailCallbackHandler";
import { consumirPendienteOrientacionCorreo } from "../core/gmail/emailOrientationStore";
import { consumirPendienteEdicionBorrador } from "../core/gmail/emailDraftEditStore";
import { handlePagoRecurrenteCallback, continuarConMontoPago } from "../core/fiscal/pagoRecurrenteCallbackHandler";
import { consumirPendienteMontoPago, guardarPendienteMontoPago } from "../core/fiscal/pendienteMontoStore";
import { revisarCostosIA } from "../core/jobs/revisarCostosIA";
import type { TelegramUpdate } from "../core/telegram/types";

const app = express();
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.post("/webhook/telegram", async (req: Request, res: Response) => {
  // Respondemos 200 de inmediato para que Telegram no reintente el update.
  res.sendStatus(200);

  const update = req.body as TelegramUpdate;

  const remitente = update.callback_query?.from ?? update.message?.from;
  if (!(await esUsuarioAutorizado(remitente?.id))) {
    console.warn(
      `[auth] Bloqueado usuario no autorizado — id: ${remitente?.id}, username: ${remitente?.username ?? "(sin username)"}`
    );

    if (update.callback_query) {
      await answerCallbackQuery(update.callback_query.id, "No tienes acceso a este asistente.").catch(() => {});
    } else if (update.message && remitente) {
      const nombre = [remitente.first_name, remitente.last_name].filter(Boolean).join(" ");
      await Promise.all([
        sendTelegramMessage(
          update.message.chat.id,
          "🔒 No tienes acceso a este asistente. Ya avisé a un administrador para que te dé acceso."
        ).catch(() => {}),
        notificarSolicitudAcceso({ userId: remitente.id, nombre, username: remitente.username }).catch((error) =>
          console.error("[auth] Error notificando solicitud de acceso a admins:", error)
        ),
      ]);
    }
    return;
  }

  if (update.callback_query) {
    const data = update.callback_query.data ?? "";

    if (data.startsWith("auth_")) {
      await handleAuthCallback(update.callback_query);
      return;
    }

    if (esAccionSensible(data) && (await obtenerRolUsuario(remitente?.id)) !== "admin") {
      console.warn(`[auth] Colaborador sin permiso intentó acción sensible — id: ${remitente?.id}, accion: ${data}`);
      await answerCallbackQuery(
        update.callback_query.id,
        "Esta acción requiere aprobación de un administrador."
      ).catch(() => {});
      return;
    }

    try {
      if (data.startsWith("doc_")) {
        await handleDocumentCallback(update.callback_query);
      } else if (data.startsWith("email_")) {
        await handleEmailActionCallback(update.callback_query);
      } else if (data.startsWith("draft_")) {
        await handleDraftCallback(update.callback_query);
      } else if (data.startsWith("recpago_")) {
        await handlePagoRecurrenteCallback(update.callback_query);
      } else {
        await handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      console.error("Error procesando callback_query de Telegram:", error);
    }
    return;
  }

  if (update.message?.document || update.message?.photo) {
    // Si el caption trae "CAPTURA:", se captura ese texto directo (no el
    // archivo) — mismo comportamiento que un mensaje de texto normal.
    const caption = update.message.caption;
    if (caption && esMensajeCaptura(caption)) {
      try {
        await guardarCaptura(caption, update.message.from?.username);
        await sendTelegramMessage(update.message.chat.id, "✅ Guardado, gracias.");
      } catch (error) {
        console.error("Error guardando captura de conocimiento:", error);
        await sendTelegramMessage(update.message.chat.id, "Hubo un error guardando la captura. Intenta de nuevo.");
      }
      return;
    }

    try {
      await handleIncomingFile(update.message);
    } catch (error) {
      console.error("Error procesando archivo entrante de Telegram:", error);
    }
    return;
  }

  const incoming = parseIncomingUpdate(update);

  if (!incoming) {
    return;
  }

  if (/^\/?revisarcorreo\b/i.test(incoming.text.trim())) {
    await sendTelegramMessage(incoming.chatId, "🔄 Revisando correo nuevo...");
    revisarCorreoNuevo()
      .then((resultado) => {
        sendTelegramMessage(
          incoming.chatId,
          `✅ Revisión extraordinaria completa — ${resultado.correosRevisados} correo(s) revisado(s).`
        ).catch((error) => console.error("Error enviando confirmación de revisión de correo:", error));
      })
      .catch((error) => {
        console.error("Error en revisión extraordinaria de correo:", error);
        sendTelegramMessage(incoming.chatId, "⚠️ Hubo un error revisando el correo.").catch(() => {});
      });
    return;
  }

  if (esMensajeCaptura(incoming.text)) {
    try {
      await guardarCaptura(incoming.text, incoming.fromUsername);
      await sendTelegramMessage(incoming.chatId, "✅ Guardado, gracias.");
    } catch (error) {
      console.error("Error guardando captura de conocimiento:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error guardando la captura. Intenta de nuevo.");
    }
    return;
  }

  const pendienteMontoPago = await consumirPendienteMontoPago(incoming.chatId);
  if (pendienteMontoPago) {
    try {
      await continuarConMontoPago(pendienteMontoPago, incoming.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error procesando importe de pago recurrente:", message);
      // Se reinserta el pendiente (con creadoEn actualizado) para que el
      // usuario pueda corregir su respuesta sin tener que pulsar el botón
      // de nuevo — a diferencia de otros "pendiente_*", aquí el error es
      // casi siempre un simple problema de formato del texto, no algo grave.
      await guardarPendienteMontoPago(pendienteMontoPago);
      await sendTelegramMessage(incoming.chatId, message);
    }
    return;
  }

  const pendienteEdicionBorrador = await consumirPendienteEdicionBorrador(incoming.chatId);
  if (pendienteEdicionBorrador) {
    try {
      await continuarConEdicionBorrador(
        pendienteEdicionBorrador.chatId,
        pendienteEdicionBorrador.borradorId,
        incoming.text
      );
    } catch (error) {
      console.error("Error procesando edición de borrador de correo:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error actualizando el borrador.");
    }
    return;
  }

  const pendienteOrientacion = await consumirPendienteOrientacionCorreo(incoming.chatId);
  if (pendienteOrientacion) {
    try {
      await continuarConOrientacion(
        pendienteOrientacion.chatId,
        pendienteOrientacion.de,
        pendienteOrientacion.asunto,
        pendienteOrientacion.resumen,
        incoming.text,
        pendienteOrientacion.threadId,
        pendienteOrientacion.messageIdHeader
      );
    } catch (error) {
      console.error("Error procesando orientación específica de correo:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error procesando tu instrucción.");
    }
    return;
  }

  const pendiente = await consumirPendienteDesambiguacion(incoming.chatId);
  if (pendiente) {
    try {
      await manejarClasificacion({
        chatId: pendiente.chatId,
        rutaLocal: pendiente.rutaLocal,
        nombreArchivoOriginal: pendiente.nombreArchivoOriginal,
        mimeType: pendiente.mimeType,
        nombreParaClasificar: pendiente.nombreParaClasificar,
        captionEfectivo:
          `${pendiente.captionOriginal ?? ""}\n\n` +
          `Pregunta que se le hizo al usuario para desambiguar: ${pendiente.preguntaFormulada}\n` +
          `Respuesta del usuario: ${incoming.text}`,
      });
    } catch (error) {
      console.error("Error procesando respuesta de desambiguación:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error procesando tu respuesta. Intenta reenviar el archivo.");
    }
    return;
  }

  try {
    const reply = await askClaude(incoming.text, incoming.chatId, incoming.fromNombre);
    await sendTelegramMessage(incoming.chatId, reply);
  } catch (error) {
    console.error("Error procesando el mensaje de Telegram:", error);
    try {
      await sendTelegramMessage(
        incoming.chatId,
        "Lo siento, ha ocurrido un error procesando tu mensaje. Inténtalo de nuevo en unos minutos."
      );
    } catch (sendError) {
      console.error("Error enviando el mensaje de error a Telegram:", sendError);
    }
  }
});

/**
 * Dispara manualmente el job revisarHoldedVsCashflow, sin esperar al cron.
 * Protegido por ADMIN_SECRET (query param ?secret=...) para que no cualquiera
 * en internet pueda disparar el job. No escribe nada — solo detecta y notifica.
 */
app.post("/admin/run-holded-check", async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    res.status(503).json({ error: "ADMIN_SECRET no configurado en el servidor." });
    return;
  }

  if (req.query.secret !== adminSecret) {
    res.status(403).json({ error: "Secret inválido." });
    return;
  }

  try {
    const resultado = await revisarHoldedVsCashflow();
    res.json({ ok: true, ...resultado });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Dispara manualmente el job revisarAlertasFiscales, sin esperar al cron.
 * Protegido por ADMIN_SECRET (query param ?secret=...). No escribe nada —
 * solo detecta y notifica (y solo manda mensaje si hay algo próximo).
 */
app.post("/admin/run-fiscal-check", async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    res.status(503).json({ error: "ADMIN_SECRET no configurado en el servidor." });
    return;
  }

  if (req.query.secret !== adminSecret) {
    res.status(403).json({ error: "Secret inválido." });
    return;
  }

  try {
    const resultado = await revisarAlertasFiscales();
    res.json({ ok: true, ...resultado });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Lectura de solo diagnóstico de docs/conocimiento_capturado.md, para
 * verificar qué hay capturado sin tener que preguntarle al bot por
 * Telegram. Protegido por ADMIN_SECRET.
 */
app.get("/admin/conocimiento-capturado", async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    res.status(503).json({ error: "ADMIN_SECRET no configurado en el servidor." });
    return;
  }

  if (req.query.secret !== adminSecret) {
    res.status(403).json({ error: "Secret inválido." });
    return;
  }

  try {
    const contenido = await readFile(join(process.cwd(), "docs", "conocimiento_capturado.md"), "utf-8");
    res.type("text/plain").send(contenido);
  } catch {
    res.status(404).json({ error: "docs/conocimiento_capturado.md no existe todavía." });
  }
});

/**
 * Dispara manualmente el job revisarCorreoNuevo, sin esperar al cron.
 * Protegido por ADMIN_SECRET (query param ?secret=...). Solo detecta y
 * propone (documentos van por el flujo de aprobación existente) — nunca
 * responde correos ni ejecuta instrucciones que vengan en ellos.
 *
 * Con muchos correos nuevos esto puede tardar minutos (una llamada a Claude
 * por correo, más por cada adjunto a clasificar), así que responde de
 * inmediato y corre en segundo plano en vez de bloquear la petición HTTP.
 */
app.post("/admin/run-gmail-check", (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    res.status(503).json({ error: "ADMIN_SECRET no configurado en el servidor." });
    return;
  }

  if (req.query.secret !== adminSecret) {
    res.status(403).json({ error: "Secret inválido." });
    return;
  }

  res.json({ ok: true, mensaje: "Revisión de correo iniciada en segundo plano." });

  revisarCorreoNuevo().catch((error) => {
    console.error("[admin/run-gmail-check] Error:", error);
  });
});

/**
 * Dispara manualmente el job revisarCostosIA, sin esperar al cron. Protegido
 * por ADMIN_SECRET. Solo lectura/notificación — no escribe nada.
 */
app.post("/admin/run-costos-check", async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    res.status(503).json({ error: "ADMIN_SECRET no configurado en el servidor." });
    return;
  }

  if (req.query.secret !== adminSecret) {
    res.status(403).json({ error: "Secret inválido." });
    return;
  }

  try {
    const resultado = await revisarCostosIA();
    res.json({ ok: true, ...resultado });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

app.listen(PORT, () => {
  console.log(`WOBA Copilot escuchando en el puerto ${PORT}`);
  startScheduler();
});
