import "dotenv/config";
import "../core/google/globalOptions";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import { parseIncomingUpdate, sendTelegramMessage, sendTelegramMessageSmart, answerCallbackQuery, iniciarIndicadorEscribiendo, avisarTrabajando, entregarRespuestaTrasTrabajar } from "../core/telegram/client";
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
import { handleDocumentCallback } from "../core/documental/documentCallbackHandler";
import { consumirPendienteDesambiguacion } from "../core/documental/disambiguationStore";
import { consumirPendienteReglaClasificacion } from "../core/documental/pendienteReglaClasificacionStore";
import { registrarReglaClasificacion } from "../core/documental/carpetaReglaStore";
import { consumirPendienteAlertaDocumento } from "../core/documental/pendienteAlertaDocumentoStore";
import { manejarClasificacion } from "../core/documental/processClassification";
import { esMensajeCaptura } from "../core/knowledge/capture";
import { obtenerCapturasCrudas } from "../core/knowledge/capturaSheet";
import { iniciarSeleccionEmpresaCaptura, handleCapturaEmpresaCallback } from "../core/knowledge/capturaEmpresaCallbackHandler";
import { obtenerPendientesCapturaEmpresaPorChat } from "../core/knowledge/pendienteCapturaEmpresaStore";
import { askClaude, buscarEnInternet } from "../core/claude/client";
import { obtenerBusquedasRecientes, obtenerResumenBusquedasWeb } from "../core/claude/webSearchLog";
import { obtenerAccionesPendientes } from "../core/jobs/accionesProgramadasStore";
import { startScheduler } from "../core/jobs/scheduler";
import { revisarHoldedVsCashflow } from "../core/jobs/revisarHoldedVsCashflow";
import { revisarAlertasFiscales } from "../core/jobs/revisarAlertasFiscales";
import { revisarCorreoNuevo } from "../core/jobs/revisarCorreoNuevo";
import { handleEmailActionCallback, continuarConOrientacion, handleDraftCallback, continuarConEdicionBorrador } from "../core/gmail/emailCallbackHandler";
import { consumirPendienteOrientacionCorreo } from "../core/gmail/emailOrientationStore";
import { handleCashflowAnnotationActionCallback, continuarConOrientacionAnotacion } from "../core/jobs/cashflowAnnotationCallbackHandler";
import { consumirPendienteOrientacionAnotacion } from "../core/jobs/cashflowAnnotationOrientationStore";
import { handleAccionProgramadaCallback } from "../core/jobs/accionesProgramadasCallbackHandler";
import { consumirPendienteEdicionBorrador } from "../core/gmail/emailDraftEditStore";
import { handlePagoRecurrenteCallback, continuarConMontoPago } from "../core/fiscal/pagoRecurrenteCallbackHandler";
import { consumirPendienteMontoPago, guardarPendienteMontoPago } from "../core/fiscal/pendienteMontoStore";
import { revisarCostosIA } from "../core/jobs/revisarCostosIA";
import { handleGastoCallback, continuarConCorreccionGasto } from "../core/gastos/gastoCallbackHandler";
import { consumirPendienteCorreccionGasto } from "../core/gastos/pendienteCorreccionGastoStore";
import { handleEventoCallback } from "../core/crm/eventoCallbackHandler";
import { obtenerEstadoCerebro } from "../core/cerebro/estadoAgregado";
import { obtenerEstadoConexiones, arreglarConexion } from "../core/cerebro/conexiones";
import { crearSolicitudAcceso, obtenerSolicitudAcceso } from "../core/cerebro/accesoSolicitudSheet";
import { notificarSolicitudAccesoCerebro, handleAccesoCerebroCallback } from "../core/cerebro/accesoCallbackHandler";
import { handleReporteContableCallback } from "../core/reportes/reporteContableCallbackHandler";
import { esTokenTemporalValido, listarTokensActivos, revocarTokenTemporal } from "../core/cerebro/tempTokenStore";
import { listarAccesosMaestroOtorgados } from "../core/cerebro/accesoMaestroAuditSheet";
import type { TelegramUpdate } from "../core/telegram/types";

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

const app = express();
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
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

  if (!(await exigeAccesoValido(req, res))) return;

  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!id) {
    res.status(400).json({ error: "Falta 'id'." });
    return;
  }

  try {
    const conexion = await arreglarConexion(id);
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

  try {
    const resultado = await buscarEnInternet(query);
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
      } else if (data.startsWith("capturaempresa_")) {
        await handleCapturaEmpresaCallback(update.callback_query);
      } else if (data.startsWith("anotcf_")) {
        await handleCashflowAnnotationActionCallback(update.callback_query);
      } else if (data.startsWith("accprog_")) {
        await handleAccionProgramadaCallback(update.callback_query);
      } else if (data.startsWith("reportecontable_")) {
        await handleReporteContableCallback(update.callback_query);
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
      const detenerEscribiendo = iniciarIndicadorEscribiendo(incoming.chatId);
      const mensajeTrabajandoId = await avisarTrabajando(incoming.chatId);
      try {
        const respuesta = await askClaude(incoming.text, incoming.chatId, incoming.fromNombre);
        await entregarRespuestaTrasTrabajar(incoming.chatId, mensajeTrabajandoId, respuesta);
      } catch (error) {
        console.error("Error capturando correo:", error);
        await entregarRespuestaTrasTrabajar(
          incoming.chatId,
          mensajeTrabajandoId,
          "Hubo un error leyendo el correo para capturarlo. Intenta de nuevo."
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
      const respuesta = await askClaude(instruccion, incoming.chatId);
      await sendTelegramMessageSmart(incoming.chatId, respuesta);
    } catch (error) {
      console.error("Error programando alerta de documento:", error);
      await sendTelegramMessage(incoming.chatId, "Hubo un error programando la alerta. Intenta de nuevo.");
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
    try {
      await entregarRespuestaTrasTrabajar(
        incoming.chatId,
        mensajeTrabajandoId,
        "Lo siento, ha ocurrido un error procesando tu mensaje. Inténtalo de nuevo en unos minutos."
      );
    } catch (sendError) {
      console.error("Error enviando el mensaje de error a Telegram:", sendError);
    }
  } finally {
    detenerEscribiendo();
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
