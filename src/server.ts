import "dotenv/config";
import express, { type Request, type Response } from "express";
import { parseIncomingUpdate, sendTelegramMessage } from "../core/telegram/client";
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

  if (update.callback_query) {
    const data = update.callback_query.data ?? "";
    try {
      if (data.startsWith("doc_")) {
        await handleDocumentCallback(update.callback_query);
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
    const reply = await askClaude(incoming.text);
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

app.listen(PORT, () => {
  console.log(`WOBA Copilot escuchando en el puerto ${PORT}`);
  startScheduler();
});
