import "dotenv/config";
import "../core/google/globalOptions";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";
import express, { type Request, type Response } from "express";
import { parseIncomingUpdate, sendTelegramMessage, sendTelegramMessageSmart, sendTelegramMessageWithButtons, answerCallbackQuery, iniciarIndicadorEscribiendo, avisarTrabajando, entregarRespuestaTrasTrabajar } from "../core/telegram/client";
import { mensajeFalloTurno } from "../core/claude/turnSafety";
import { prepararAcuseCallback } from "../core/telegram/client";
import {
  esUsuarioAutorizado,
  esAccionSensible,
  obtenerRolUsuario,
  puedeAprobarAccionSensible,
  obtenerUsuariosAutorizados,
  autorizarUsuario,
  eliminarUsuario,
  type Rol,
} from "../core/telegram/authorizedUsersSheet";
import { notificarSolicitudAcceso, handleAuthCallback } from "../core/telegram/adminNotify";
import { handleCallbackQuery } from "../core/telegram/callbackHandler";
import { handleIncomingFile } from "../core/documental/receiveFile";
import { handleDocumentCallback, handleDesambiguacionCallback } from "../core/documental/documentCallbackHandler";
import { consumirPendienteDesambiguacion } from "../core/documental/disambiguationStore";
import { consumirPendienteReglaClasificacion } from "../core/documental/pendienteReglaClasificacionStore";
import { registrarReglaClasificacion } from "../core/documental/carpetaReglaStore";
import { consumirPendienteAlertaDocumento } from "../core/documental/pendienteAlertaDocumentoStore";
import { manejarClasificacion } from "../core/documental/processClassification";
import { esMensajeCaptura } from "../core/knowledge/capture";
import { obtenerCapturasCrudas } from "../core/knowledge/capturaSheet";
import { iniciarSeleccionEmpresaCaptura, handleCapturaEmpresaCallback } from "../core/knowledge/capturaEmpresaCallbackHandler";
import { obtenerPendientesCapturaEmpresaPorChat } from "../core/knowledge/pendienteCapturaEmpresaStore";
import { askClaude, buscarEnInternet, esErrorSaldoAnthropicAgotado } from "../core/claude/client";
import { obtenerHistorialVisible } from "../core/claude/conversationStore";
import { obtenerBusquedasRecientes, obtenerResumenBusquedasWeb } from "../core/claude/webSearchLog";
import { obtenerAccionesPendientes } from "../core/jobs/accionesProgramadasStore";
import { startScheduler, obtenerCantidadJobsEnCurso } from "../core/jobs/scheduler";
import { revisarHoldedVsCashflow } from "../core/jobs/revisarHoldedVsCashflow";
import { revisarAlertasFiscales } from "../core/jobs/revisarAlertasFiscales";
import { revisarCorreoNuevo, handleColaCorreoSiguienteCallback, handleDescartarActivoCallback } from "../core/jobs/revisarCorreoNuevo";
import { handleDescartarTodoPendienteCallback, handleDescartarItemPendienteCallback } from "../core/jobs/resumenPendientesDiario";
import { handleEmailActionCallback, continuarConOrientacion, handleDraftCallback, continuarConEdicionBorrador } from "../core/gmail/emailCallbackHandler";
import { obtenerEstadoEnviosCorreoDurables, reconciliarEnviosCorreoAlArrancar } from "../core/gmail/client";
import { consumirPendienteOrientacionCorreo } from "../core/gmail/emailOrientationStore";
import { handleCashflowAnnotationActionCallback, continuarConOrientacionAnotacion } from "../core/jobs/cashflowAnnotationCallbackHandler";
import { consumirPendienteOrientacionAnotacion } from "../core/jobs/cashflowAnnotationOrientationStore";
import { handleAccionProgramadaCallback } from "../core/jobs/accionesProgramadasCallbackHandler";
import { consumirPendienteEdicionBorrador } from "../core/gmail/emailDraftEditStore";
import { handlePagoRecurrenteCallback, continuarConMontoPago } from "../core/fiscal/pagoRecurrenteCallbackHandler";
import { consumirPendienteMontoPago, guardarPendienteMontoPago } from "../core/fiscal/pendienteMontoStore";
import { revisarCostosIA } from "../core/jobs/revisarCostosIA";
import {
  handleGastoCallback,
  continuarConCorreccionGasto,
  continuarConAjusteMonto,
  continuarConAccionGasto,
  continuarConSeleccionGasto,
} from "../core/gastos/gastoCallbackHandler";
import { consumirPendienteCorreccionGasto } from "../core/gastos/pendienteCorreccionGastoStore";
import { consumirPendienteAjusteMontoGasto } from "../core/gastos/pendienteAjusteMontoGastoStore";
import { consumirPendienteAccionGasto } from "../core/gastos/pendienteAccionGastoStore";
import { consumirPendienteSeleccionGasto } from "../core/gastos/pendienteSeleccionGastoStore";
import { obtenerDiagnosticoMetadataPestanas } from "../core/google/sheetsKeyValueStore";
import { handleEdicionCompraHoldedCallback } from "../core/holded/edicionCompraHoldedCallbackHandler";
import { handleEdicionValorCashflowCallback } from "../core/google/edicionValorCashflowCallbackHandler";
import { handleRegistroManualCashflowCallback } from "../core/google/registroManualCashflowCallbackHandler";
import { handleEventoCallback } from "../core/crm/eventoCallbackHandler";
import { invalidarEstadoCerebro, obtenerEstadoCerebro } from "../core/cerebro/estadoAgregado";
import { obtenerEstadoConexiones, arreglarConexion } from "../core/cerebro/conexiones";
import { obtenerRevisionCerebro, publicarCambioCerebro, suscribirCambiosCerebro } from "../core/cerebro/realtime";
import { crearSolicitudAcceso, obtenerSolicitudAcceso } from "../core/cerebro/accesoSolicitudSheet";
import { notificarSolicitudAccesoCerebro, handleAccesoCerebroCallback } from "../core/cerebro/accesoCallbackHandler";
import { handleReporteContableCallback } from "../core/reportes/reporteContableCallbackHandler";
import { handleAutorespuestaHiloCallback } from "../core/gmail/autorespuestaHiloCallbackHandler";
import { esTokenTemporalValido, listarTokensActivos, revocarTokenTemporal } from "../core/cerebro/tempTokenStore";
import { resolverIdentidadChatWeb } from "../core/cerebro/webChatIdentity";
import { crearSolicitudVinculoChat, confirmarVinculoChat } from "../core/cerebro/chatLinkStore";
import {
  ConflictoIdempotencia,
  procesarSolicitudChat,
  solicitudesChatEnCurso,
} from "../core/cerebro/webChatCoordinator";
import { webChatRequestStore } from "../core/cerebro/webChatRequestStore";
import { listarAccesosMaestroOtorgados } from "../core/cerebro/accesoMaestroAuditSheet";
import { verificarGithubToken } from "../core/github/client";
import { handleAutorrepairCallback } from "../core/github/autorrepairCallbackHandler";
import { handleEscalacionCallback } from "../core/github/escalacionCallbackHandler";
import { crearPendienteAutorrepair } from "../core/github/autorrepairPendienteStore";
import { autorrevisionCodigo } from "../core/jobs/autorrevisionCodigo";
import type { TelegramUpdate } from "../core/telegram/types";
import {
  CoordinadorEntregasTelegram,
  configuracionEntregasDurables,
  type EntregaTelegramDurable,
} from "../core/telegram/durableDelivery";
import { durableDeliveryStore } from "../core/telegram/durableDeliveryStore";
import { obtenerEstadoPlanificadorHerramientas } from "../core/tools/scheduler";
import { resumirMetricasCachesLectura } from "../core/utils/readCache";
import { obtenerEstadoSubidasDriveDurables, reconciliarSubidasDriveAlArrancar } from "../core/drive/client";
import {
  obtenerEstadoCreacionesCompraDurables,
  obtenerEstadoEdicionesCompraDurables,
  obtenerEstadoAdjuntosCompraDurables,
  obtenerEstadoConciliacionesMovimientoDurables,
  reconciliarCreacionesCompraAlArrancar,
  reconciliarEdicionesCompraAlArrancar,
  reconciliarAdjuntosCompraAlArrancar,
  reconciliarMovimientosAlArrancar,
} from "../core/holded/write";

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

// Bug real encontrado en vivo (2026-09-02): un correo con adjunto se quedó
// "activo" para siempre en la cola de revisión (core/jobs/revisarCorreoNuevo.ts)
// sin ningún mensaje de error en Telegram y sin nada en los logs — el patrón
// exacto de una excepción no capturada en algún punto de la cadena de
// promesas (procesarDocumentoLocal → extraerDatosFactura → Holded/Drive),
// que por defecto en Node.js >=15 TERMINA todo el proceso en silencio en vez
// de solo fallar esa request. Mismo tipo de causa raíz ya identificado antes
// en esta sesión para el caso de "Alberto no recibía respuesta". En vez de
// perseguir cada punto de la cadena que podría faltarle un catch, esto
// neutraliza la CLASE completa de bug: cualquier promesa no manejada queda
// solo registrada en logs, el proceso sigue vivo, y como mucho esa request
// puntual queda sin respuesta (recuperable) en vez de tumbar el servidor
// entero (no recuperable sin que Railway lo reinicie, perdiendo cualquier
// otro request en curso al mismo tiempo).
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection (el proceso sigue vivo, no se cae):", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[server] uncaughtException (el proceso sigue vivo, no se cae):", error);
});

/**
 * Hallazgo real de auditoría (caso real, Carlos, 2026-09-09): pidió confirmar si un movimiento era una
 * transferencia interna, el bot respondió "Trabajando en tu consulta..." — y un redeploy normal de
 * Railway (rollout, varias veces por sesión en desarrollo activo) llegó a mitad de ese procesamiento y
 * mató el proceso. En aquel momento el webhook de Telegram respondía 200 OK antes de guardar el update;
 * el bloque 4 ahora exige una reserva durable antes de ese ACK. El trabajo REAL sigue corriendo en
 * segundo plano, sin ninguna conexión HTTP abierta que un shutdown "normal" (esperar a que las requests
 * en curso terminen) pueda detectar. Railway por defecto solo da 3 segundos entre SIGTERM y SIGKILL —
 * muchísimo menos que lo que tarda un turno real de Claude con herramientas — así que sin esto, CADA
 * redeploy durante una conversación activa mata esa conversación en silencio, sin ningún error visible
 * ni para Carlos ni en los logs.
 *
 * `actualizacionesEnCurso` cuenta cuántos updates de Telegram siguen procesándose de verdad ahora mismo
 * (incrementado/decrementado alrededor de procesarUpdateTelegram, ver /webhook/telegram, y de cualquier
 * otro trabajo real que responda rápido y siga corriendo después — ver trackearEnSegundoPlano). Al
 * recibir SIGTERM, se espera a que llegue a 0 — Y a que obtenerCantidadJobsEnCurso() (core/jobs/scheduler.ts)
 * también llegue a 0, hallazgo real de auditoría xhigh: un cron (ej. autorrevisionCodigo, que escribe
 * rama+commit+PR en GitHub) puede estar corriendo sin que haya ningún update de Telegram en curso al
 * mismo tiempo, y un redeploy lo mataría igual de silenciosamente si solo se mirara lo primero — con
 * esperaMaximaDrenajeMs de margen, unos segundos por debajo del drainingSeconds real configurado en
 * railway.json) antes de salir voluntariamente. servidorHttp.close() se llama primero para dejar de
 * aceptar conexiones NUEVAS de inmediato (otro hallazgo real de auditoría: sin esto, Railway podía
 * seguir mandando updates nuevos durante toda la ventana de espera, y alguno que llegara justo antes del
 * límite se mataría igual) — así Railway nunca necesita llegar al SIGKILL para el caso común, y ningún
 * trabajo en curso se pierde solo porque coincidió con un despliegue.
 */
let actualizacionesEnCurso = 0;
let cerrandoPorSigterm = false;
let servidorHttp: HttpServer | null = null;

/**
 * Para cualquier trabajo real que, como /webhook/telegram, responde rápido y sigue corriendo después en
 * segundo plano (nunca esperado por el ciclo de vida normal de la request) — lo suma a
 * actualizacionesEnCurso para que el SIGTERM de arriba también lo espere. Hallazgo real de auditoría
 * xhigh: /revisarcorreo (dentro de procesarUpdateTelegram) y /admin/run-gmail-check ya tenían
 * exactamente este patrón sin trackear — el propio código que este fix dice proteger tenía el mismo
 * hueco por dentro.
 */
function trackearEnSegundoPlano<T>(promesa: Promise<T>): void {
  actualizacionesEnCurso++;
  promesa.finally(() => {
    actualizacionesEnCurso--;
  });
}

async function avisarEntregaTelegramIncierta(entrega: EntregaTelegramDurable): Promise<void> {
  if (!entrega.chatId) return;
  await sendTelegramMessage(
    entrega.chatId,
    "⚠️ Una solicitud quedó interrumpida después de comenzar. Wobi no la repitió automáticamente para evitar duplicar una acción. Consulta el estado antes de volver a ejecutarla."
  );
}

const coordinadorEntregasTelegram = new CoordinadorEntregasTelegram(
  durableDeliveryStore,
  procesarUpdateTelegram,
  avisarEntregaTelegramIncierta
);
const configuracionTelegramDurable = configuracionEntregasDurables();

process.on("SIGTERM", () => {
  if (cerrandoPorSigterm) return; // Railway no debería mandar SIGTERM dos veces, pero por si acaso.
  cerrandoPorSigterm = true;
  coordinadorEntregasTelegram.cerrar();
  servidorHttp?.close();

  const nadaEnCurso = () => actualizacionesEnCurso === 0 && obtenerCantidadJobsEnCurso() === 0 &&
    solicitudesChatEnCurso() === 0 && obtenerEstadoPlanificadorHerramientas().activas === 0 &&
    coordinadorEntregasTelegram.estado.activas === 0;

  if (nadaEnCurso()) {
    console.log("[server] SIGTERM recibido, sin trabajo en curso — saliendo de inmediato.");
    process.exit(0);
    return;
  }

  console.log(
    `[server] SIGTERM recibido con ${actualizacionesEnCurso} actualización(es) de Telegram, ${coordinadorEntregasTelegram.estado.activas} entrega(s) durable(s), ${solicitudesChatEnCurso()} chat(s) web, ${obtenerCantidadJobsEnCurso()} job(s) y ${obtenerEstadoPlanificadorHerramientas().activas} herramienta(s) activas — esperando a que terminen antes de salir.`
  );
  const esperaMaximaDrenajeMs = 55_000;
  const inicio = Date.now();
  const intervalo = setInterval(() => {
    if (nadaEnCurso()) {
      clearInterval(intervalo);
      console.log("[server] Todo el trabajo en curso terminó — saliendo.");
      process.exit(0);
    } else if (Date.now() - inicio > esperaMaximaDrenajeMs) {
      clearInterval(intervalo);
      console.error(
        `[server] Quedó trabajo sin terminar (${actualizacionesEnCurso} actualización(es), ${coordinadorEntregasTelegram.estado.activas} entrega(s) durable(s), ${solicitudesChatEnCurso()} chat(s) web, ${obtenerCantidadJobsEnCurso()} job(s), ${obtenerEstadoPlanificadorHerramientas().activas} herramienta(s)) tras ${esperaMaximaDrenajeMs}ms de espera — saliendo de todas formas (Railway va a forzar el cierre pronto).`
      );
      process.exit(0);
    }
  }, 250);
  intervalo.unref();
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req: Request, res: Response, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // El chat permite dictado solo desde este mismo origen. Cámara y ubicación
  // siguen bloqueadas; el navegador pide permiso explícito antes de usar el micro.
  res.set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  res.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://wobagroup-assistant-production.up.railway.app; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});
app.use(express.json());

interface VentanaLimite {
  inicio: number;
  usos: number;
}

/** Defensa simple en proceso; los límites globales de IA siguen aplicándose aparte. */
function crearLimitador(maximo: number, ventanaMs: number) {
  const ventanas = new Map<string, VentanaLimite>();
  return (clave: string): { permitido: boolean; reintentarEnSegundos: number } => {
    const ahora = Date.now();
    if (ventanas.size >= 5_000 && !ventanas.has(clave)) {
      const primera = ventanas.keys().next().value;
      if (primera) ventanas.delete(primera);
    }
    const actual = ventanas.get(clave);
    if (!actual || ahora - actual.inicio >= ventanaMs) {
      ventanas.set(clave, { inicio: ahora, usos: 1 });
      return { permitido: true, reintentarEnSegundos: 0 };
    }
    if (actual.usos >= maximo) {
      return { permitido: false, reintentarEnSegundos: Math.max(1, Math.ceil((ventanaMs - (ahora - actual.inicio)) / 1000)) };
    }
    actual.usos += 1;
    return { permitido: true, reintentarEnSegundos: 0 };
  };
}

const limitarSolicitudesAcceso = crearLimitador(5, 10 * 60 * 1000);
const limitarBusquedasPanel = crearLimitador(30, 60 * 60 * 1000);

let invalidacionTelegramPendiente: NodeJS.Timeout | null = null;
function programarActualizacionCerebroDesdeTelegram(): void {
  if (invalidacionTelegramPendiente) clearTimeout(invalidacionTelegramPendiente);
  invalidacionTelegramPendiente = setTimeout(() => {
    invalidacionTelegramPendiente = null;
    invalidarEstadoCerebro();
    publicarCambioCerebro("telegram");
  }, 12_000);
  invalidacionTelegramPendiente.unref();
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.get("/health", (_req: Request, res: Response) => {
  const herramientas = obtenerEstadoPlanificadorHerramientas();
  res.json({
    status: "ok",
    trabajo: { herramientasActivas: herramientas.activas, herramientasPendientes: herramientas.pendientes },
    cacheLecturas: resumirMetricasCachesLectura(),
    metadataSheets: obtenerDiagnosticoMetadataPestanas(),
    entregasTelegram: { habilitado: configuracionTelegramDurable.habilitado, ...coordinadorEntregasTelegram.estado },
    enviosCorreo: obtenerEstadoEnviosCorreoDurables(),
    subidasDrive: obtenerEstadoSubidasDriveDurables(),
    comprasHolded: obtenerEstadoCreacionesCompraDurables(),
    edicionesHolded: obtenerEstadoEdicionesCompraDurables(),
    adjuntosHolded: obtenerEstadoAdjuntosCompraDurables(),
    conciliacionesHolded: obtenerEstadoConciliacionesMovimientoDurables(),
  });
});

// La raíz del dominio nunca tuvo ninguna página propia — sin esto, entrar a
// https://copilot.wobagroup.com/ directo (sin /cerebro) muestra "Cannot GET
// /", que parece que nada está desplegado aunque el servicio esté bien.
app.get("/", (_req: Request, res: Response) => {
  res.redirect("/cerebro/");
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
app.use(
  "/cerebro",
  express.static(CEREBRO_DIST, {
    setHeaders: (res, path) => {
      if (path.includes(`${join("cerebro", "assets")}`) || path.includes("/assets/")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);
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

/** Igual que /api/cerebro/estado: acepta la key maestra o un token temporal vigente. */
async function exigeAccesoValido(req: Request, res: Response): Promise<boolean> {
  const cerebroKey = process.env.CEREBRO_API_KEY;
  if (!cerebroKey) {
    res.status(503).json({ error: "CEREBRO_API_KEY no configurado en el servidor." });
    return false;
  }
  const keyRecibida = req.get("X-Cerebro-Key") ?? "";
  const esValida = keyRecibida === cerebroKey || (await esTokenTemporalValido(keyRecibida));
  if (!esValida) {
    res.status(403).json({ error: "X-Cerebro-Key inválida o ausente." });
    return false;
  }
  return true;
}

/**
 * Canal de invalidación en tiempo real. Envía solo metadatos; los datos de
 * negocio se siguen leyendo por /estado, con autenticación y caché propios.
 * fetch streaming permite conservar X-Cerebro-Key sin ponerla en la URL.
 */
app.get("/api/cerebro/stream", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");
  if (!(await exigeAccesoValido(req, res))) return;

  res.status(200);
  res.set("Content-Type", "text/event-stream; charset=utf-8");
  res.set("Cache-Control", "no-cache, no-transform");
  res.set("Connection", "keep-alive");
  res.set("X-Accel-Buffering", "no");
  res.flushHeaders();

  const escribir = (evento: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  escribir("listo", { revision: obtenerRevisionCerebro(), en: new Date().toISOString() });
  const cancelar = suscribirCambiosCerebro((evento) => escribir("actualizar", evento));
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
  }, 20_000);
  ping.unref();

  req.on("close", () => {
    clearInterval(ping);
    cancelar();
  });
});

app.options("/api/cerebro/stream", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");
  res.sendStatus(204);
});

/**
 * Estado de las conexiones externas (Telegram, Claude, Google Sheets/Drive/
 * Gmail, Holded x3) para el panel de conexiones — ver core/cerebro/conexiones.ts.
 */
app.get("/api/cerebro/conexiones", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");

  if (!(await exigeAccesoValido(req, res))) return;

  try {
    const conexiones = await obtenerEstadoConexiones();
    res.json({ conexiones });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/conexiones] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/conexiones", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");
  res.sendStatus(204);
});

app.post("/api/cerebro/conexiones/arreglar", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");

  // Reconfigurar un webhook o forzar un ping de Claude no es una lectura:
  // solo la sesión maestra puede hacerlo.
  if (!exigeKeyMaestra(req, res)) return;

  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!id) {
    res.status(400).json({ error: "Falta 'id'." });
    return;
  }

  try {
    const conexion = await arreglarConexion(id);
    publicarCambioCerebro(`conexion:${id}`);
    res.json({ conexion });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/conexiones/arreglar] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/conexiones/arreglar", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");
  res.sendStatus(204);
});

/**
 * Resumen + historial reciente de búsquedas web reales (query, resultados,
 * costo) — pedido explícito de Carlos: no solo saber que el módulo está
 * conectado, sino qué se ha buscado y qué ha costado. Ver core/claude/webSearchLog.ts.
 */
app.get("/api/cerebro/busqueda-web", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");

  if (!(await exigeAccesoValido(req, res))) return;

  try {
    const [resumen, recientes] = await Promise.all([obtenerResumenBusquedasWeb(), obtenerBusquedasRecientes(20)]);
    res.json({ resumen, recientes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/busqueda-web] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/busqueda-web", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");
  res.sendStatus(204);
});

/**
 * Pedido explícito de Carlos: el módulo de calendario del front debe
 * mostrar "un pequeño calendario en donde vea si hay cosas programadas" —
 * lee la misma cola que revisarAccionesProgramadas.ts (Sheets), no un
 * calendario aparte.
 */
app.get("/api/cerebro/acciones-programadas", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");

  if (!(await exigeAccesoValido(req, res))) return;

  try {
    const pendientes = await obtenerAccionesPendientes();
    res.json({ pendientes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/acciones-programadas] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/acciones-programadas", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");
  res.sendStatus(204);
});

/**
 * Buscador directo del panel /cerebro — pedido explícito de Carlos: "un
 * pequeño panel... como un pequeño buscador opcional desde el mismo
 * sistema". Dispara una búsqueda real (con costo real, ver
 * core/claude/webSearchLog.ts) — nunca se llama sola, solo cuando alguien
 * la pide explícitamente desde el front.
 */
app.post("/api/cerebro/buscar", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");

  if (!(await exigeAccesoValido(req, res))) return;

  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Falta 'query'." });
    return;
  }

  const limite = limitarBusquedasPanel(req.ip || req.socket.remoteAddress || "desconocido");
  if (!limite.permitido) {
    res.set("Retry-After", String(limite.reintentarEnSegundos));
    res.status(429).json({ error: "Límite de búsquedas del panel alcanzado. Intenta más tarde." });
    return;
  }

  try {
    const resultado = await buscarEnInternet(query);
    invalidarEstadoCerebro();
    publicarCambioCerebro("busqueda_web");
    res.json(resultado);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/buscar] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/buscar", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");
  res.sendStatus(204);
});

function corsChat(res: Response, metodo: "GET" | "POST"): void {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key, X-Cerebro-Nombre, X-Cerebro-Device, Content-Type");
  res.set("Access-Control-Allow-Methods", metodo);
}

function nombreDesdeHeader(req: Request): string {
  const valor = req.get("X-Cerebro-Nombre") ?? "";
  try {
    return decodeURIComponent(valor).trim().slice(0, 100);
  } catch {
    return valor.trim().slice(0, 100);
  }
}

async function identidadChatDesdeRequest(req: Request) {
  return resolverIdentidadChatWeb(
    req.get("X-Cerebro-Key") ?? "",
    nombreDesdeHeader(req),
    req.get("X-Cerebro-Device") ?? ""
  );
}

function identidadPublica(identidad: Awaited<ReturnType<typeof identidadChatDesdeRequest>>) {
  if (!identidad) return null;
  return {
    nombre: identidad.nombre,
    rol: identidad.rol,
    vinculadaTelegram: identidad.vinculadaTelegram,
    modo: identidad.modo,
  };
}

/**
 * Historial textual común. Si el dispositivo fue vinculado por Telegram,
 * usa exactamente el mismo chatId que el bot; nunca expone tool inputs,
 * tool results, claves ni razonamiento interno.
 */
app.get("/api/cerebro/chat", async (req: Request, res: Response) => {
  corsChat(res, "GET");
  const identidad = await identidadChatDesdeRequest(req);
  if (!identidad) {
    res.status(403).json({ error: "Sesión de chat inválida o dispositivo no reconocido." });
    return;
  }

  const mensajes = await obtenerHistorialVisible(identidad.chatId);
  res.json({ identidad: identidadPublica(identidad), mensajes });
});

app.options("/api/cerebro/chat", (_req: Request, res: Response) => {
  corsChat(res, "GET");
  res.set("Access-Control-Allow-Methods", "GET, POST");
  res.sendStatus(204);
});

const solicitudesChatPorMinuto = new Map<number, Map<string, number>>();

function puedeEnviarMensajeChat(chatId: number, messageId: string): boolean {
  const ahora = Date.now();
  const recientes = solicitudesChatPorMinuto.get(chatId) ?? new Map<string, number>();
  for (const [id, momento] of recientes) {
    if (ahora - momento >= 60_000) recientes.delete(id);
  }
  // Los reintentos idempotentes no consumen una plaza adicional del límite.
  if (recientes.has(messageId)) return true;
  if (recientes.size >= 10) return false;
  recientes.set(messageId, ahora);
  solicitudesChatPorMinuto.set(chatId, recientes);
  return true;
}

/**
 * Entrada idempotente del chat web. messageId nace en el navegador y se
 * persiste ANTES de llamar al modelo. Un retry con el mismo id se une a la
 * ejecución viva o devuelve su respuesta anterior; nunca vuelve a ejecutar
 * el turno ni sus herramientas.
 */
app.post("/api/cerebro/chat", async (req: Request, res: Response) => {
  corsChat(res, "POST");
  const identidad = await identidadChatDesdeRequest(req);
  if (!identidad) {
    res.status(403).json({ error: "Sesión de chat inválida o dispositivo no reconocido." });
    return;
  }

  const messageId = typeof req.body?.messageId === "string" ? req.body.messageId.trim() : "";
  const texto = typeof req.body?.texto === "string" ? req.body.texto.trim() : "";
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(messageId)) {
    res.status(400).json({ error: "messageId ausente o inválido." });
    return;
  }
  if (!texto || texto.length > 4_000) {
    res.status(400).json({ error: "El mensaje debe tener entre 1 y 4.000 caracteres." });
    return;
  }
  if (!puedeEnviarMensajeChat(identidad.chatId, messageId)) {
    res.status(429).json({ error: "Demasiados mensajes seguidos. Espera un minuto antes de continuar." });
    return;
  }

  try {
    const resultado = await procesarSolicitudChat(
      { requestId: messageId, chatId: identidad.chatId, texto },
      webChatRequestStore,
      () =>
        askClaude(texto, identidad.chatId, identidad.nombre, "chat_conversacional", {
          soloLectura: identidad.modo === "solo_lectura",
          presentacion: "web",
        })
    );

    if (resultado.estado === "procesando") {
      res.status(202).json({ estado: resultado.estado, duplicada: true });
      return;
    }
    if (resultado.estado === "fallido") {
      res.status(409).json({
        estado: resultado.estado,
        error: "La ejecución anterior quedó interrumpida y no se repitió para evitar duplicar acciones.",
      });
      return;
    }

    publicarCambioCerebro("chat_web");
    res.json({
      estado: resultado.estado,
      respuesta: resultado.respuesta,
      duplicada: resultado.duplicada,
      identidad: identidadPublica(identidad),
    });
  } catch (error) {
    if (error instanceof ConflictoIdempotencia) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("[api/cerebro/chat] Error procesando mensaje:", error instanceof Error ? error.name : "Error");
    res.status(500).json({ error: mensajeFalloTurno(error) });
  }
});

/** Crea un código de 10 minutos que solo puede confirmar el usuario desde su propio Telegram autorizado. */
app.post("/api/cerebro/chat/vincular", async (req: Request, res: Response) => {
  corsChat(res, "POST");
  const identidad = await identidadChatDesdeRequest(req);
  if (!identidad) {
    res.status(403).json({ error: "Sesión de chat inválida o dispositivo no reconocido." });
    return;
  }
  try {
    const resultado = await crearSolicitudVinculoChat(req.get("X-Cerebro-Device") ?? "", identidad.nombre);
    res.json(resultado);
  } catch (error) {
    console.error("[api/cerebro/chat/vincular] Error:", error instanceof Error ? error.name : "Error");
    res.status(500).json({ error: "No se pudo crear el código de vinculación." });
  }
});

app.options("/api/cerebro/chat/vincular", (_req: Request, res: Response) => {
  corsChat(res, "POST");
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

  const limite = limitarSolicitudesAcceso(req.ip || req.socket.remoteAddress || "desconocido");
  if (!limite.permitido) {
    res.set("Retry-After", String(limite.reintentarEnSegundos));
    res.status(429).json({ error: "Demasiadas solicitudes de acceso. Espera unos minutos." });
    return;
  }

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

app.get("/api/cerebro/accesos-maestro-otorgados", async (req: Request, res: Response) => {
  if (!exigeKeyMaestra(req, res)) return;

  try {
    const otorgados = await listarAccesosMaestroOtorgados();
    res.json({ otorgados });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/accesos-maestro-otorgados] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/accesos-maestro-otorgados", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");
  res.sendStatus(204);
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
    if (existia) publicarCambioCerebro("acceso_revocado");
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

/**
 * Gestión de usuarios autorizados (admins/colaboradores) desde el panel de
 * /cerebro — cambiar rol o quitar acceso. Solo con la key maestra, igual
 * que el resto de endpoints admin-only de este bloque. Antes esto solo se
 * podía hacer a mano en el Sheet o desde los botones de aprobación inicial
 * en Telegram (adminNotify.ts) — no había forma de reasignar rol ni quitar
 * acceso ya dado.
 */
app.get("/api/cerebro/usuarios-autorizados", async (req: Request, res: Response) => {
  if (!exigeKeyMaestra(req, res)) return;

  try {
    const usuarios = await obtenerUsuariosAutorizados();
    res.json({ usuarios });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/usuarios-autorizados] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/usuarios-autorizados", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key");
  res.set("Access-Control-Allow-Methods", "GET");
  res.sendStatus(204);
});

app.post("/api/cerebro/cambiar-rol-usuario", async (req: Request, res: Response) => {
  if (!exigeKeyMaestra(req, res)) return;

  const userId = Number(req.body?.userId);
  const rol = req.body?.rol as Rol;
  if (!userId || (rol !== "superadmin" && rol !== "admin" && rol !== "colaborador")) {
    res.status(400).json({ error: "Falta 'userId' o 'rol' inválido (debe ser 'superadmin', 'admin' o 'colaborador')." });
    return;
  }

  try {
    const usuarios = await obtenerUsuariosAutorizados();
    const existente = usuarios.find((u) => u.userId === userId);
    if (!existente) {
      res.status(404).json({ error: "Ese usuario ya no está en la lista de autorizados." });
      return;
    }
    await autorizarUsuario(userId, rol, existente.nombre);
    invalidarEstadoCerebro();
    publicarCambioCerebro("usuario_rol_actualizado");
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/cambiar-rol-usuario] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/cambiar-rol-usuario", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");
  res.sendStatus(204);
});

app.post("/api/cerebro/eliminar-usuario", async (req: Request, res: Response) => {
  if (!exigeKeyMaestra(req, res)) return;

  const userId = Number(req.body?.userId);
  if (!userId) {
    res.status(400).json({ error: "Falta 'userId'." });
    return;
  }

  try {
    const existia = await eliminarUsuario(userId);
    if (existia) {
      invalidarEstadoCerebro();
      publicarCambioCerebro("usuario_eliminado");
    }
    res.json({ ok: existia });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/cerebro/eliminar-usuario] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.options("/api/cerebro/eliminar-usuario", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "X-Cerebro-Key, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");
  res.sendStatus(204);
});

/**
 * Hallazgo real de auditoría (caso real, Carlos, 2026-09-09): un redeploy de Railway (rollout normal,
 * varias veces por sesión en desarrollo activo) mató a mitad de camino el procesamiento de este mismo
 * handler — Telegram ya había recibido su 200 OK antes de que existiera un registro recuperable, así que el
 * "trabajando en tu consulta..." se quedó sin respuesta para siempre, sin ningún error visible y sin
 * ninguna forma de que Carlos supiera que el proceso simplemente murió. `procesarUpdateTelegram` es el
 * cuerpo real de lo que antes era el handler inline; la reserva/ACK vive ahora fuera de esta función
 * para poder persistir antes de confirmar la entrega. La función nombrada permite además trackear
 * cuántas actualizaciones siguen realmente en curso (ver `actualizacionesEnCurso`
 * y el handler de SIGTERM más abajo), que ahora espera a que terminen antes de dejar que Railway mate
 * el proceso, en vez de cortarlas a mitad de camino.
 */
async function procesarUpdateTelegram(update: TelegramUpdate): Promise<void> {

  if (update.callback_query) {
    prepararAcuseCallback(update.callback_query.id, update.callback_query.from.id);
  }

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

  // La mayoría de los cambios visibles del panel nacen en Telegram. Se
  // agrupan durante 12 s para esperar a que termine el flujo y evitar una
  // reconstrucción costosa por cada mensaje o botón consecutivo.
  programarActualizacionCerebroDesdeTelegram();

  if (update.callback_query) {
    const data = update.callback_query.data ?? "";

    if (data.startsWith("auth_")) {
      await handleAuthCallback(update.callback_query);
      return;
    }

    if (esAccionSensible(data) && !puedeAprobarAccionSensible(await obtenerRolUsuario(remitente?.id))) {
      console.warn(`[auth] Usuario sin permiso de superadmin intentó acción sensible — id: ${remitente?.id}, accion: ${data}`);
      await answerCallbackQuery(
        update.callback_query.id,
        "Esta acción requiere aprobación del superadministrador."
      ).catch(() => {});
      return;
    }

    try {
      if (data.startsWith("doc_")) {
        await handleDocumentCallback(update.callback_query);
      } else if (data.startsWith("desamb_")) {
        await handleDesambiguacionCallback(update.callback_query);
      } else if (data.startsWith("colacorreo_")) {
        if (data === "colacorreo_descartaractivo") {
          await handleDescartarActivoCallback(update.callback_query);
        } else {
          await handleColaCorreoSiguienteCallback(update.callback_query);
        }
      } else if (data === "resumen_descartar_todo") {
        await handleDescartarTodoPendienteCallback(update.callback_query);
      } else if (data.startsWith("resumen_descartar_item:")) {
        await handleDescartarItemPendienteCallback(update.callback_query);
      } else if (data.startsWith("email_")) {
        await handleEmailActionCallback(update.callback_query);
      } else if (data.startsWith("draft_")) {
        await handleDraftCallback(update.callback_query);
      } else if (data.startsWith("recpago_")) {
        await handlePagoRecurrenteCallback(update.callback_query);
      } else if (data.startsWith("gasto_")) {
        await handleGastoCallback(update.callback_query);
      } else if (data.startsWith("edicioncompra_")) {
        await handleEdicionCompraHoldedCallback(update.callback_query);
      } else if (data.startsWith("edicioncashflow_")) {
        await handleEdicionValorCashflowCallback(update.callback_query);
      } else if (data.startsWith("regmanualcf_")) {
        await handleRegistroManualCashflowCallback(update.callback_query);
      } else if (data.startsWith("evento_")) {
        await handleEventoCallback(update.callback_query);
      } else if (data.startsWith("cerebroacceso_")) {
        await handleAccesoCerebroCallback(update.callback_query);
      } else if (data.startsWith("capturaempresa_")) {
        await handleCapturaEmpresaCallback(update.callback_query);
      } else if (data.startsWith("anotcf_")) {
        await handleCashflowAnnotationActionCallback(update.callback_query);
      } else if (data.startsWith("accprog_")) {
        await handleAccionProgramadaCallback(update.callback_query);
      } else if (data.startsWith("reportecontable_")) {
        await handleReporteContableCallback(update.callback_query);
      } else if (data.startsWith("autohilo_")) {
        await handleAutorespuestaHiloCallback(update.callback_query);
      } else if (data.startsWith("autorrepair_")) {
        await handleAutorrepairCallback(update.callback_query);
      } else if (data.startsWith("escaladev_")) {
        await handleEscalacionCallback(update.callback_query);
      } else {
        await handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      console.error("Error procesando callback_query de Telegram:", error);
    }
    return;
  }

  if (update.message?.document || update.message?.photo) {
    // Bug real encontrado en vivo (2026-09-01): antes, si el caption traía
    // la palabra "CAPTURA" (ej. una foto real de un directorio de accesos
    // con caption "captura"), este atajo guardaba el TEXTO del caption tal
    // cual ("captura") como si fuera el conocimiento — el archivo/foto
    // adjunto nunca se descargaba ni se leía. Carlos recibió "✅ Guardado —
    // WOBA" (una confirmación real) y minutos después, al preguntar por esa
    // misma información, el sistema no tenía nada útil guardado — la
    // captura real nunca llegó a leerse. Ahora TODO documento/foto entrante
    // pasa siempre por handleIncomingFile (que sí descarga y lee el
    // contenido con Claude vision) — el clasificador (classifyFile.ts)
    // reconoce la palabra "CAPTURA" en el caption como señal explícita de
    // "recuerda esto" (parece_intencion_de_captura) y dispara el mismo
    // flujo de transcripción + guardado que ya existía para correos con
    // adjuntos, en vez de un atajo aparte que nunca leía el archivo.
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

  const codigoVinculo = incoming.text.trim().match(/^\/?vincular\s+([a-zA-Z0-9-]{6,8})$/i)?.[1];
  if (codigoVinculo && remitente) {
    const nombreTelegram = incoming.fromNombre || [remitente.first_name, remitente.last_name].filter(Boolean).join(" ");
    try {
      const vinculo = await confirmarVinculoChat(codigoVinculo, remitente.id, nombreTelegram);
      await sendTelegramMessage(
        incoming.chatId,
        vinculo
          ? `✅ El dispositivo solicitado como "${vinculo.nombreSolicitud}" ya está vinculado a tu cuenta. Puedes continuar la misma conversación desde el front de Wobi.`
          : "⚠️ Ese código no existe o venció. Genera uno nuevo desde el chat web."
      );
    } catch (error) {
      console.error("[chat/vincular] Error confirmando vínculo:", error instanceof Error ? error.name : "Error");
      await sendTelegramMessage(incoming.chatId, "⚠️ No pude completar la vinculación. Inténtalo de nuevo.");
    }
    return;
  }

  if (/^\/?(revisarcorreo|revisamail)\b/i.test(incoming.text.trim())) {
    await sendTelegramMessage(incoming.chatId, "🔄 Revisando correo nuevo...");
    trackearEnSegundoPlano(
      revisarCorreoNuevo(true) // forzarAviso: lo pidió Carlos ahora mismo, sin importar el día ni si ya se avisó hoy
      .then((resultado) => {
        // Pedido explícito de Carlos, tras un caso real: pidió /revisarcorreo
        // con varios correos reales sin leer en Gmail, y el sistema
        // respondió "0 correos revisados" sin más — la causa real era un
        // correo "activo" con una pregunta sin responder desde horas antes
        // (bloqueando el resto de la cola), pero el aviso no lo decía. Ahora,
        // si ese es el caso, se avisa explícitamente qué es lo que falta
        // resolver en vez de dar a entender que no había nada pendiente.
        if (resultado.activoBloqueando) {
          // Pedido explícito de Carlos, tras un caso real: "esto ya lo
          // gestioné" — a veces el correo activo ya está resuelto por su
          // cuenta (fuera del chat), y antes la única salida era esperar
          // 48h o encontrar el mensaje original. El botón lo libera ya
          // mismo (ver handleDescartarActivoCallback).
          sendTelegramMessageWithButtons(
            incoming.chatId,
            `⏸️ Ya tienes un correo activo esperando tu respuesta: "${resultado.activoBloqueando.asunto}" (de ${resultado.activoBloqueando.de}) — resuélvelo (los botones de esa pregunta siguen arriba en el chat) para que el resto de la cola pueda avanzar.`,
            [[{ text: "🗑️ Descartar y liberar", callback_data: "colacorreo_descartaractivo" }]]
          ).catch((error) => console.error("Error enviando confirmación de revisión de correo:", error));
        } else {
          sendTelegramMessage(
            incoming.chatId,
            `✅ Revisión extraordinaria completa — ${resultado.correosRevisados} correo(s) revisado(s).`
          ).catch((error) => console.error("Error enviando confirmación de revisión de correo:", error));
        }
      })
      .catch((error) => {
        console.error("Error en revisión extraordinaria de correo:", error);
        sendTelegramMessage(incoming.chatId, "⚠️ Hubo un error revisando el correo.").catch(() => {});
      })
    );
    return;
  }

  if (esMensajeCaptura(incoming.text)) {
    if (esCapturaDeCorreo(incoming.text)) {
      // "CAPTURA lo que llegó en el correo de X" no trae la información en sí
      // — hay que ir a leer el correo real (capturar_correo) en vez de
      // guardar la instrucción tal cual, que es lo que hacía antes y dejaba
      // la base de conocimiento sin nada útil.
      const detenerEscribiendo = iniciarIndicadorEscribiendo(incoming.chatId);
      const mensajeTrabajandoId = await avisarTrabajando(incoming.chatId);
      try {
        const respuesta = await askClaude(incoming.text, incoming.chatId, incoming.fromNombre, "capturar_correo_chat");
        await entregarRespuestaTrasTrabajar(incoming.chatId, mensajeTrabajandoId, respuesta);
      } catch (error) {
        console.error("Error capturando correo:", error);
        // Hallazgo real de auditoría: el mensaje específico de saldo agotado (ver askClaude en
        // core/claude/client.ts) solo se aplicaba en el flujo principal de chat — este flujo tenía su
        // propio mensaje genérico fijo, así que un usuario en medio de capturar un correo justo cuando
        // se agotó el saldo veía el mismo mensaje inútil de siempre, aunque el aviso a admins ya
        // funcionaba igual (vive dentro de askClaude, no depende de quién lo llame).
        await entregarRespuestaTrasTrabajar(
          incoming.chatId,
          mensajeTrabajandoId,
          esErrorSaldoAnthropicAgotado(error)
            ? "🚨 El saldo de la cuenta de Anthropic se agotó — no puedo leer el correo hasta que se recargue crédito. Ya avisé a los administradores."
            : "Hubo un error leyendo el correo para capturarlo. Intenta de nuevo."
        );
      } finally {
        detenerEscribiendo();
      }
      return;
    }

    try {
      await iniciarSeleccionEmpresaCaptura(incoming.chatId, incoming.text, incoming.fromUsername);
    } catch (error) {
      console.error("Error iniciando la pregunta de empresa para la captura:", error);
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

  const pendienteAjusteMontoGasto = await consumirPendienteAjusteMontoGasto(incoming.chatId);
  if (pendienteAjusteMontoGasto) {
    try {
      await continuarConAjusteMonto(pendienteAjusteMontoGasto, incoming.text);
    } catch (error) {
      console.error("Error procesando ajuste de monto de gasto:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error procesando el ajuste de monto.");
    }
    return;
  }

  const pendienteAccionGasto = await consumirPendienteAccionGasto(incoming.chatId);
  if (pendienteAccionGasto) {
    try {
      await continuarConAccionGasto(pendienteAccionGasto, incoming.text);
    } catch (error) {
      console.error("Error procesando otras acciones sobre una propuesta de gasto:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error procesando tu instrucción.");
    }
    return;
  }

  const pendienteSeleccionGasto = await consumirPendienteSeleccionGasto(incoming.chatId);
  if (pendienteSeleccionGasto) {
    try {
      await continuarConSeleccionGasto(pendienteSeleccionGasto, incoming.text);
    } catch (error) {
      console.error("Error procesando la cola de selección de una propuesta de gasto:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error procesando tu respuesta.");
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
        pendienteOrientacion.messageIdHeader,
        pendienteOrientacion.deColaCorreo
      );
    } catch (error) {
      console.error("Error procesando orientación específica de correo:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error procesando tu instrucción.");
    }
    return;
  }

  const pendienteOrientacionAnotacion = await consumirPendienteOrientacionAnotacion(incoming.chatId);
  if (pendienteOrientacionAnotacion) {
    try {
      await continuarConOrientacionAnotacion(
        pendienteOrientacionAnotacion.chatId,
        pendienteOrientacionAnotacion.ubicacion,
        pendienteOrientacionAnotacion.detalle,
        pendienteOrientacionAnotacion.recomendacion,
        incoming.text
      );
    } catch (error) {
      console.error("Error procesando orientación específica de anotación de cashflow:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error procesando tu instrucción.");
    }
    return;
  }

  const pendienteRegla = await consumirPendienteReglaClasificacion(incoming.chatId);
  if (pendienteRegla) {
    try {
      await registrarReglaClasificacion({
        empresa: pendienteRegla.empresa,
        criterio: incoming.text.trim(),
        tipoDocumento: pendienteRegla.tipoDocumento,
        carpetaDestino: pendienteRegla.carpetaDestino,
      });
      await sendTelegramMessage(
        incoming.chatId,
        `✅ Aprendido — la próxima vez que un documento de ${pendienteRegla.empresa} coincida con "${incoming.text.trim()}", lo archivo directo en "${pendienteRegla.carpetaDestino}" sin preguntar.`
      );
    } catch (error) {
      console.error("Error registrando regla de clasificación:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error guardando la regla. Intenta de nuevo.");
    }
    return;
  }

  const pendienteAlertaDoc = await consumirPendienteAlertaDocumento(incoming.chatId);
  if (pendienteAlertaDoc) {
    try {
      const instruccion =
        `El usuario quiere programar una alerta/recordatorio relacionado con un documento que se está ` +
        `archivando ahora mismo. Documento: "${pendienteAlertaDoc.nombreArchivoOriginal}" (${pendienteAlertaDoc.empresa}, ` +
        `${pendienteAlertaDoc.tipoDocumento}). Lo que pide el usuario: "${incoming.text}". Usa la herramienta ` +
        `programar_accion_futura para dejarlo programado (interpreta la fecha o condición que haya dado) — no lo ` +
        `hagas ahora mismo, solo prográmalo.`;
      const respuesta = await askClaude(instruccion, incoming.chatId, undefined, "resolver_alerta_documento");
      await sendTelegramMessageSmart(incoming.chatId, respuesta);
    } catch (error) {
      console.error("Error programando alerta de documento:", error);
      // Ver hallazgo real de auditoría junto al catch de "capturar_correo_chat" más arriba.
      await sendTelegramMessage(
        incoming.chatId,
        esErrorSaldoAnthropicAgotado(error)
          ? "🚨 El saldo de la cuenta de Anthropic se agotó — no puedo programar la alerta hasta que se recargue crédito. Ya avisé a los administradores."
          : "Hubo un error programando la alerta. Intenta de nuevo."
      );
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
        correoOrigen: pendiente.correoOrigen,
        esContinuacionDesambiguacion: true,
      });
    } catch (error) {
      console.error("Error procesando respuesta de desambiguación:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error procesando tu respuesta. Intenta reenviar el archivo.");
    }
    return;
  }

  // Si hay una captura de conocimiento esperando que elijan la empresa y
  // confirmen, y el usuario en cambio manda un mensaje normal, avisa —
  // sin esto, la selección se pierde en silencio a los 30 min y ni el
  // usuario ni el asistente vuelven a mencionarlo: pasó dos veces (2026-08-27
  // y 2026-08-28) que alguien tocó una empresa pero nunca "Confirmar y
  // guardar", y al preguntar después el asistente decía "no encontré nada"
  // sin ninguna pista de que la captura nunca se había guardado.
  const pendientesCapturaEmpresa = await obtenerPendientesCapturaEmpresaPorChat(incoming.chatId);
  if (pendientesCapturaEmpresa.length > 0) {
    const texto =
      pendientesCapturaEmpresa.length === 1
        ? "⏳ Tienes una captura de conocimiento sin confirmar (arriba) — todavía no se guardó nada. " +
          'Pulsa "✅ Confirmar y guardar" en ese mensaje, o "❌ Cancelar" si ya no aplica.'
        : `⏳ Tienes ${pendientesCapturaEmpresa.length} capturas de conocimiento sin confirmar (arriba) — todavía no ` +
          'se guardó nada de eso. Pulsa "✅ Confirmar y guardar" en cada mensaje, o "❌ Cancelar" si ya no aplica.';
    await sendTelegramMessage(incoming.chatId, texto).catch((error) =>
      console.error("Error avisando de captura pendiente sin confirmar:", error)
    );
  }

  const detenerEscribiendo = iniciarIndicadorEscribiendo(incoming.chatId);
  const mensajeTrabajandoId = await avisarTrabajando(incoming.chatId);
  try {
    const reply = await askClaude(incoming.text, incoming.chatId, incoming.fromNombre);
    await entregarRespuestaTrasTrabajar(incoming.chatId, mensajeTrabajandoId, reply);
  } catch (error) {
    console.error("Error procesando el mensaje de Telegram:", error);
    // Hallazgo real de auditoría (caso real, Carlos, 2026-09-09): con el saldo de Anthropic agotado,
    // este mensaje genérico era la ÚNICA señal visible — no decía qué pasaba de verdad. Ahora, para
    // este caso específico, se lo dice directo en el chat (además del aviso aparte a todos los admins,
    // ver avisarSaldoAnthropicAgotado en core/claude/client.ts) — el propio chat se vuelve la alerta.
    const mensajeError = esErrorSaldoAnthropicAgotado(error)
      ? "🚨 El saldo de la cuenta de Anthropic se agotó — no puedo responder hasta que se recargue crédito en console.anthropic.com → Plans & Billing. Ya avisé a los administradores."
      : mensajeFalloTurno(error);
    try {
      await entregarRespuestaTrasTrabajar(incoming.chatId, mensajeTrabajandoId, mensajeError);
    } catch (sendError) {
      console.error("Error enviando el mensaje de error a Telegram:", sendError);
    }
  } finally {
    detenerEscribiendo();
  }
}

// Fallback reversible del bloque 4. Solo se usa si el interruptor durable se
// desactiva expresamente en Railway.
const telegramUpdatesRecientes = new Map<number, number>();
function esUpdateTelegramNuevoLocal(updateId: number): boolean {
  const ahora = Date.now();
  for (const [id, vistoEn] of telegramUpdatesRecientes) {
    if (ahora - vistoEn > 24 * 60 * 60 * 1000) telegramUpdatesRecientes.delete(id);
  }
  if (telegramUpdatesRecientes.has(updateId)) return false;
  telegramUpdatesRecientes.set(updateId, ahora);
  return true;
}

app.post("/webhook/telegram", (req: Request, res: Response) => {
  const update = req.body as TelegramUpdate;
  if (!Number.isFinite(update.update_id)) {
    res.sendStatus(200);
    return;
  }

  if (!configuracionTelegramDurable.habilitado) {
    res.sendStatus(200);
    if (!esUpdateTelegramNuevoLocal(update.update_id)) return;
    actualizacionesEnCurso++;
    procesarUpdateTelegram(update)
      .catch((error) => console.error("Error no capturado procesando el webhook de Telegram:", error))
      .finally(() => { actualizacionesEnCurso--; });
    return;
  }

  actualizacionesEnCurso++;
  coordinadorEntregasTelegram.reservar(
    update,
    Boolean(update.callback_query && esAccionSensible(update.callback_query.data ?? ""))
  )
    .then(async ({ entrega, nueva }) => {
      // Telegram solo recibe 200 después de que la entrega quedó durable.
      // El procesamiento real continúa fuera del ciclo HTTP, como antes.
      res.sendStatus(200);
      if (!nueva && update.callback_query) {
        const texto = entrega.estado === "completada"
          ? "Esta acción ya fue procesada."
          : entrega.estado === "incierta"
            ? "Esta acción quedó con resultado incierto; comprueba su estado antes de repetirla."
            : "Esta acción ya está en proceso.";
        await answerCallbackQuery(update.callback_query.id, texto).catch(() => undefined);
      }
      await coordinadorEntregasTelegram.atender(entrega, nueva);
    })
    .catch((error) => {
      console.error("Error en entrega durable de Telegram:", error instanceof Error ? error.name : "Error");
      // Si todavía no se confirmó, Telegram puede reenviar el mismo update.
      if (!res.headersSent) res.sendStatus(503);
    })
    .finally(() => {
      actualizacionesEnCurso--;
    });
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

  trackearEnSegundoPlano(
    revisarCorreoNuevo(true).catch((error) => { // forzarAviso: se disparó a mano vía este endpoint admin
      console.error("[admin/run-gmail-check] Error:", error);
    })
  );
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

/**
 * Diagnóstico de una sola vez: confirma que GITHUB_TOKEN (recién configurado
 * para la futura autorrevisión nocturna) es válido y tiene los permisos
 * necesarios — sin exponer el valor del token en ningún momento. La prueba de
 * escritura crea y borra en el acto una rama de prueba (mismo commit que ya
 * existe, sin archivos ni commits nuevos). Protegido igual que los demás
 * endpoints admin.
 */
app.get("/admin/verificar-github-token", async (req: Request, res: Response) => {
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
    const resultado = await verificarGithubToken();
    res.json(resultado);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Dispara manualmente la autorrevisión nocturna de código, sin esperar al
 * cron. Protegido por ADMIN_SECRET. Nunca despliega nada por sí sola — como
 * mucho abre PR(s) y manda mensaje(s) de aprobación a Telegram.
 */
app.post("/admin/run-autorrevision-codigo", async (req: Request, res: Response) => {
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
    const resultado = await autorrevisionCodigo();
    res.json({ ok: true, ...resultado });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Pedido explícito de Carlos: al pulsar "Crear issue" en una escalación desde el chat, que además de
 * quedar registrado para development, se le mande la solicitud a Claude para que investigue y proponga
 * un arreglo real. La investigación/propuesta corre FUERA de este servidor, en GitHub Actions (ver
 * .github/workflows/claude-issue-autofix.yml — usa anthropics/claude-code-action, mismo integración ya
 * probada por la autorrevisión nocturna en modo sombra), porque ahí Claude puede tener acceso de
 * escritura a CUALQUIER archivo del repo sin las restricciones de la autorrevisión nocturna (que solo
 * puede tocar core/utils/ — decisión explícita de Carlos, distinta para este flujo) — ese workflow
 * corre en la infraestructura de GitHub, no en Railway, así que no puede llamar directo a
 * crearPendienteAutorrepair/sendTelegramMessageWithButtons como sí hace autorrevisionCodigo.ts (mismo
 * proceso Node). Este endpoint es el puente: una vez el workflow abre el PR real, hace un POST acá con
 * los datos, y de ahí en adelante es EXACTAMENTE el mismo mecanismo de aprobación ya usado por la
 * autorrevisión nocturna (autorrepairCallbackHandler.ts) — el PR nunca se fusiona sin el tap de
 * "✅ Desplegar" en Telegram, sin importar si lo propuso el cron nocturno o este flujo por Issue.
 *
 * Reutiliza ADMIN_SECRET (ya configurado en Railway para los demás endpoints /admin/*) en vez de un
 * secreto nuevo — Carlos solo necesita copiar ese mismo valor como secret de GitHub Actions
 * (Settings → Secrets and variables → Actions → New repository secret, nombre ADMIN_SECRET) para que
 * el workflow pueda autenticarse acá.
 */
app.post("/webhook/github-autofix", async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.status(503).json({ error: "ADMIN_SECRET no configurado en el servidor." });
    return;
  }

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${adminSecret}`) {
    res.status(403).json({ error: "Secret inválido." });
    return;
  }

  const { numeroPR, rama, urlPR, resumen, chatId, issueNumero } = req.body ?? {};
  if (
    typeof numeroPR !== "number" ||
    typeof rama !== "string" ||
    !rama ||
    typeof urlPR !== "string" ||
    !urlPR ||
    typeof resumen !== "string" ||
    !resumen ||
    typeof chatId !== "number"
  ) {
    res.status(400).json({ error: "Faltan campos — se esperan numeroPR (number), rama (string), urlPR (string), resumen (string), chatId (number)." });
    return;
  }

  try {
    await crearPendienteAutorrepair({
      numeroPR,
      rama,
      ruta: issueNumero ? `Issue #${issueNumero}` : "Escalación desde el chat",
      resumen,
      urlPR,
      chatId,
    });

    await sendTelegramMessageWithButtons(
      chatId,
      `🔧 **Arreglo propuesto por Claude**${issueNumero ? ` para el issue #${issueNumero}` : ""}:\n\n${resumen}\n\n${urlPR}`,
      [
        [
          { text: "✅ Desplegar", callback_data: `autorrepair_desplegar:${numeroPR}` },
          { text: "❌ Descartar", callback_data: `autorrepair_descartar:${numeroPR}` },
        ],
      ]
    );

    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[webhook/github-autofix] Error registrando el autofix propuesto:", message);
    res.status(500).json({ ok: false, error: message });
  }
});

servidorHttp = app.listen(PORT, () => {
  console.log(`WOBA Copilot escuchando en el puerto ${PORT}`);
  startScheduler();
  if (configuracionTelegramDurable.habilitado) {
    trackearEnSegundoPlano(
      coordinadorEntregasTelegram.recuperar().catch((error) => {
        console.error("[telegram/durable] No se pudo revisar entregas recuperables al arrancar:", error instanceof Error ? error.name : "Error");
      })
    );
  }
  trackearEnSegundoPlano(
    reconciliarEnviosCorreoAlArrancar()
      .then((r) => {
        if (r.revisados > 0) {
          console.log("[gmail/durable] Reconciliación de arranque:", JSON.stringify(r));
        }
      })
      .catch((error) => {
        console.error("[gmail/durable] No se pudo reconciliar el ledger al arrancar:", error instanceof Error ? error.name : "Error");
      })
  );
  trackearEnSegundoPlano(
    reconciliarSubidasDriveAlArrancar()
      .then((r) => {
        if (r.revisadas > 0) {
          console.log("[drive/durable] Reconciliación de arranque:", JSON.stringify(r));
        }
      })
      .catch((error) => {
        console.error("[drive/durable] No se pudo reconciliar el ledger al arrancar:", error instanceof Error ? error.name : "Error");
      })
  );
  trackearEnSegundoPlano(
    reconciliarCreacionesCompraAlArrancar()
      .then((r) => {
        if (r.revisadas > 0) {
          console.log("[holded/durable] Reconciliación de compras al arrancar:", JSON.stringify(r));
        }
      })
      .catch((error) => {
        console.error("[holded/durable] No se pudo reconciliar el ledger al arrancar:", error instanceof Error ? error.name : "Error");
      })
  );
  trackearEnSegundoPlano(
    reconciliarEdicionesCompraAlArrancar()
      .then((r) => {
        if (r.revisadas > 0) {
          console.log("[holded/durable] Reconciliación de ediciones al arrancar:", JSON.stringify(r));
        }
      })
      .catch((error) => {
        console.error(
          "[holded/durable] No se pudo reconciliar el ledger de ediciones al arrancar:",
          error instanceof Error ? error.name : "Error"
        );
      })
  );
  trackearEnSegundoPlano(
    reconciliarAdjuntosCompraAlArrancar()
      .then((r) => {
        if (r.revisados > 0) {
          console.log("[holded/durable] Reconciliación de adjuntos al arrancar:", JSON.stringify(r));
        }
      })
      .catch((error) => {
        console.error(
          "[holded/durable] No se pudo reconciliar el ledger de adjuntos al arrancar:",
          error instanceof Error ? error.name : "Error"
        );
      })
  );
  trackearEnSegundoPlano(
    reconciliarMovimientosAlArrancar()
      .then((r) => {
        if (r.revisadas > 0) {
          console.log("[holded/durable] Reconciliación bancaria al arrancar:", JSON.stringify(r));
        }
      })
      .catch((error) => {
        console.error(
          "[holded/durable] No se pudo reconciliar el ledger bancario al arrancar:",
          error instanceof Error ? error.name : "Error"
        );
      })
  );
});
