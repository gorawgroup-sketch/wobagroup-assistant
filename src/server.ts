import "dotenv/config";
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

// Heurística para distinguir "CAPTURA: <la información va aquí mismo>" (se
// guarda literal, sin tocar Claude) de "CAPTURA lo que llegó en el correo de
// X" (la información NO está en el mensaje — hay que ir a leer el correo
// real con la tool capturar_correo). Solo dispara si menciona un correo Y
// una referencia a que llegó/se recibió, para no capturar por esta vía un
// mensaje que solo menciona la palabra "correo" de pasada.
const CAPTURA_REFERENCIA_CORREO = /\b(correo|email|mail)s?\b/i;
const CAPTURA_LLEGADA = /\b(lleg[oó]|recib[ií]|recibido|entrante|acaba de llegar)\b/i;
function esCapturaDeCorreo(texto: string): boolean {
  return CAPTURA_REFERENCIA_CORREO.test(texto) && CAPTURA_LLEGADA.test(texto);
}
import { obtenerCapturasCrudas } from "../core/knowledge/capturaSheet";
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
import { handleGastoCallback, continuarConCorreccionGasto } from "../core/gastos/gastoCallbackHandler";
import { consumirPendienteCorreccionGasto } from "../core/gastos/pendienteCorreccionGastoStore";
import { handleEventoCallback } from "../core/crm/eventoCallbackHandler";
import { obtenerEstadoCerebro } from "../core/cerebro/estadoAgregado";
import { crearSolicitudAcceso, obtenerSolicitudAcceso } from "../core/cerebro/accesoSolicitudSheet";
import { notificarSolicitudAccesoCerebro, handleAccesoCerebroCallback } from "../core/cerebro/accesoCallbackHandler";
import { esTokenTemporalValido, listarTokensActivos, revocarTokenTemporal } from "../core/cerebro/tempTokenStore";
import type { TelegramUpdate } from "../core/telegram/types";

const app = express();
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

/**
 * Front estático del "cerebro" (React + Vite, build en frontend-cerebro/dist
 * — ver la sección "build" de package.json, que compila este front como
 * parte del build general). Servido bajo /cerebro, con base: '/cerebro/'
 * en vite.config.js para que las referencias a assets del build coincidan
 * con este mount point. No es un SPA con rutas propias (todo pasa dentro
 * de un solo componente), así que basta con servir index.html en la raíz
 * de /cerebro además de los assets estáticos — no hace falta un catch-all.
 */
const CEREBRO_DIST = join(process.cwd(), "frontend-cerebro", "dist");
app.use("/cerebro", express.static(CEREBRO_DIST));
app.get("/cerebro", (_req: Request, res: Response) => {
  res.sendFile(join(CEREBRO_DIST, "index.html"));
});

/**
 * Endpoint de datos para el front del "cerebro" (dashboard de solo lectura).
 * Protegido por X-Cerebro-Key (no por ADMIN_SECRET — es un endpoint
 * distinto, pensado para que lo consuma un front, no un curl manual de
 * admin). CORS abierto SOLO en esta ruta, para que el front (en otro
 * origen) pueda leerlo directo desde el navegador — ningún otro endpoint
 * del sistema lo necesita. Nunca escribe nada: obtenerEstadoCerebro solo
 * llama funciones de lectura.
 */
app.get("/api/cerebro/estado", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");

  const cerebroKey = process.env.CEREBRO_API_KEY;
  if (!cerebroKey) {
    res.status(503).json({ error: "CEREBRO_API_KEY no configurado en el servidor." });
    return;
  }

  const keyRecibida = req.get("X-Cerebro-Key") ?? "";
  // Acepta la key maestra O un token temporal vigente (ver
  // core/cerebro/tempTokenStore.ts) — el flujo de solicitud de acceso
  // entrega uno u otro según lo que decida el admin al aprobar.
  const esValida = keyRecibida === cerebroKey || (await esTokenTemporalValido(keyRecibida));
  if (!esValida) {
    res.status(403).json({ error: "X-Cerebro-Key inválida o ausente." });
    return;
  }

  try {
    const estado = await obtenerEstadoCerebro();
    res.json(estado);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/estado] Error agregando estado:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/estado", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");
  res.sendStatus(204);
});

/**
 * Solicita acceso al front del cerebro: alguien manda su nombre, se crea una
 * solicitud pendiente y se notifica a TODOS los admins por Telegram con
 * botones (temporal / key maestra / rechazar) — nunca entrega ningún acceso
 * directamente. CORS abierto, igual que el resto del grupo /api/cerebro —
 * no requiere ninguna key (es el paso ANTES de tener una).
 */
app.post("/api/cerebro/solicitar-acceso", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");

  const nombre = typeof req.body?.nombre === "string" ? req.body.nombre.trim().slice(0, 100) : "";
  if (!nombre) {
    res.status(400).json({ error: "Falta 'nombre'." });
    return;
  }

  try {
    const solicitud = await crearSolicitudAcceso(nombre);
    await notificarSolicitudAccesoCerebro(solicitud);
    res.json({ id: solicitud.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/solicitar-acceso] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/solicitar-acceso", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");
  res.sendStatus(204);
});

/**
 * Consulta el estado de una solicitud de acceso (polling desde el front).
 * El propio id (UUID random, no adivinable) hace de credencial de consulta
 * — no hace falta ninguna otra autenticación para este endpoint puntual.
 * Nunca revela nada de otras solicitudes.
 */
app.get("/api/cerebro/solicitud/:id", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");

  try {
    const solicitud = await obtenerSolicitudAcceso(req.params.id);
    if (!solicitud) {
      res.status(404).json({ error: "Solicitud no encontrada o vencida." });
      return;
    }
    res.json({ estado: solicitud.estado, token: solicitud.token ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/solicitud] Error:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * Panel de administración del front del cerebro: lista los accesos
 * temporales vigentes (nombre, cuándo se creó, cuándo vence) y permite
 * revocarlos — SOLO con la key maestra, nunca con un token temporal (así
 * el front puede usar "¿me deja entrar aquí?" para saber si quien entró
 * tiene la key maestra o no, sin necesitar un flag aparte). La key maestra
 * en sí no se puede revocar individualmente por persona — es un secreto
 * compartido, no hay una fila por titular; revocarla del todo significa
 * rotar CEREBRO_API_KEY, lo que saca a TODOS los que la tengan, incluido
 * quien lo pida.
 */
function exigeKeyMaestra(req: Request, res: Response): boolean {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key, Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST");

  const cerebroKey = process.env.CEREBRO_API_KEY;
  if (!cerebroKey) {
    res.status(503).json({ error: "CEREBRO_API_KEY no configurado en el servidor." });
    return false;
  }
  if (req.get("X-Cerebro-Key") !== cerebroKey) {
    res.status(403).json({ error: "Requiere la key maestra." });
    return false;
  }
  return true;
}

app.get("/api/cerebro/accesos-activos", async (req: Request, res: Response) => {
  if (!exigeKeyMaestra(req, res)) return;

  try {
    const activos = await listarTokensActivos();
    res.json({ activos });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/accesos-activos] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/accesos-activos", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");
  res.sendStatus(204);
});

app.post("/api/cerebro/revocar-acceso", async (req: Request, res: Response) => {
  if (!exigeKeyMaestra(req, res)) return;

  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!id) {
    res.status(400).json({ error: "Falta 'id'." });
    return;
  }

  try {
    const existia = await revocarTokenTemporal(id);
    res.json({ ok: existia });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/revocar-acceso] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/revocar-acceso", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");
  res.sendStatus(204);
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
      } else if (data.startsWith("gasto_")) {
        await handleGastoCallback(update.callback_query);
      } else if (data.startsWith("evento_")) {
        await handleEventoCallback(update.callback_query);
      } else if (data.startsWith("cerebroacceso_")) {
        await handleAccesoCerebroCallback(update.callback_query);
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

  if (/^\/?(revisarcorreo|revisamail)\b/i.test(incoming.text.trim())) {
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
    if (esCapturaDeCorreo(incoming.text)) {
      // "CAPTURA lo que llegó en el correo de X" no trae la información en sí
      // — hay que ir a leer el correo real (capturar_correo) en vez de
      // guardar la instrucción tal cual, que es lo que hacía antes y dejaba
      // la base de conocimiento sin nada útil.
      try {
        const respuesta = await askClaude(incoming.text, incoming.chatId, incoming.fromNombre);
        await sendTelegramMessage(incoming.chatId, respuesta);
      } catch (error) {
        console.error("Error capturando correo:", error);
        await sendTelegramMessage(incoming.chatId, "Hubo un error leyendo el correo para capturarlo. Intenta de nuevo.");
      }
      return;
    }

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

  const pendienteCorreccionGasto = await consumirPendienteCorreccionGasto(incoming.chatId);
  if (pendienteCorreccionGasto) {
    try {
      await continuarConCorreccionGasto(pendienteCorreccionGasto, incoming.text);
    } catch (error) {
      console.error("Error procesando corrección de clasificación de gasto:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error procesando la corrección.");
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
    const resultado = await revisarHoldedVsCashflow(new Date(), "semana_cerrada");
    res.json({ ok: true, ...resultado });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Dispara manualmente el chequeo PRELIMINAR de revisarHoldedVsCashflow
 * (semana en curso, lunes a la fecha de referencia) — el mismo que corre
 * el cron de los viernes 17:00, sin esperar a que llegue el viernes.
 * Protegido igual que /admin/run-holded-check.
 */
app.post("/admin/run-holded-check-preliminar", async (req: Request, res: Response) => {
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
    const resultado = await revisarHoldedVsCashflow(new Date(), "semana_en_curso");
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
 * Lectura de solo diagnóstico de las capturas registradas (pestaña oculta
 * `_capturas` del Sheet de cashflow — ver core/knowledge/capturaSheet.ts),
 * para verificar qué hay capturado sin tener que preguntarle al bot por
 * Telegram. Protegido por ADMIN_SECRET. Antes leía docs/conocimiento_capturado.md
 * en disco local, migrado el 2026-08-26 porque no sobrevivía un redeploy.
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
    const capturas = await obtenerCapturasCrudas();
    if (capturas.length === 0) {
      res.status(404).json({ error: "No hay ninguna captura registrada todavía." });
      return;
    }
    const texto = capturas.map((c) => `### ${c.fecha}${c.autor ? ` — ${c.autor}` : ""}\n\n${c.texto}\n`).join("\n");
    res.type("text/plain").send(texto);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
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
