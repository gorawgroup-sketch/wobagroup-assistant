import { obtenerPropuestasClasificacionPorChat } from "../documental/classificationStore";
import { obtenerPendienteDesambiguacionPorChat } from "../documental/disambiguationStore";
import { obtenerPendientesReclasificacionPorChat } from "../documental/pendienteReclasificacionStore";
import { obtenerGastosPendienteDatosPorChat } from "../gastos/gastoPendienteDatosStore";
import { obtenerResolucionesContactoPorChat } from "../gastos/contactoResolucionStore";
import { obtenerPropuestasGastoPorChat } from "../gastos/gastoProposalSheet";
import { obtenerPropuestasAccionCorreoPorChat } from "./emailActionStore";
import { obtenerConciliacionesPendientesPorChat } from "../gastos/conciliacionPendienteStore";
import { obtenerConciliacionesAmbiguasPendientesPorChat } from "../gastos/conciliacionAmbiguaPendienteStore";
import { obtenerPendientesOrientacionCorreoPorChat } from "./emailOrientationStore";
import { obtenerOfertasResponderCorreoPorChat } from "./emailReplyOfferStore";
import { obtenerBorradoresCorreoPorChat } from "./emailDraftStore";
import { obtenerPendientesCapturaEmpresaPorChat } from "../knowledge/pendienteCapturaEmpresaStore";

/**
 * ¿Existe ya una pregunta VIVA (con botones que el operador puede ver) para este correo exacto?
 * Vive aparte del vigilante para que la revisión manual pueda usarla sin una dependencia circular
 * (el vigilante importa la cola de correo; la cola de correo necesita esta comprobación).
 */
/**
 * Una pendiente solo protege al correo activo cuando conserva sus DOS ids.
 * Aceptar mensaje O hilo permitía que una decisión vieja de otro mensaje de
 * la misma conversación silenciara el watchdog y bloqueara la cola. Las
 * filas legacy incompletas siguen siendo legibles/respondibles, pero no son
 * evidencia suficiente para declarar que este activo exacto está atendido.
 */
export function coincideCorreoPendiente(
  origen: { deColaCorreo?: boolean; mensajeIdGmail?: string; threadId?: string } | undefined,
  mensajeId: string,
  threadId: string
): boolean {
  return Boolean(
    origen?.deColaCorreo === true &&
    origen.mensajeIdGmail?.trim() === mensajeId &&
    origen?.threadId?.trim() === threadId
  );
}

/** Las decisiones propias del flujo de email ya persisten ambos ids. Exigir
 * los dos, además del ownership explícito, impide que un borrador/oferta de
 * otro mensaje del mismo hilo o una acción manual silencie el watchdog. */
export function coincideDecisionCorreoDeCola(
  decision: { deColaCorreo?: boolean; mensajeId?: string; threadId?: string },
  mensajeId: string,
  threadId: string
): boolean {
  return decision.deColaCorreo === true &&
    decision.mensajeId?.trim() === mensajeId &&
    decision.threadId?.trim() === threadId;
}

/**
 * `undefined` = no se pudo verificar (algún store falló al leer) — hallazgo real de auditoría: antes
 * cada chequeo se tragaba su propio error y lo trataba como "no hay evidencia", así que un error de
 * lectura transitorio en Sheets sesgaba la conclusión hacia "está atascado" y disparaba un reintento
 * real (con costo de API) sobre algo que en realidad no se pudo verificar — nunca debe reintentar por
 * no haber podido comprobar, solo por haber comprobado de verdad que no hay nada.
 */
export async function huboSenalDeEntrega(chatId: number, mensajeId: string, threadId: string): Promise<boolean | undefined> {
  const coincide = (co: { deColaCorreo?: boolean; mensajeIdGmail?: string; threadId?: string } | undefined) =>
    coincideCorreoPendiente(co, mensajeId, threadId);

  const NO_VERIFICADO = Symbol("no verificado");
  const resultados = await Promise.all([
    obtenerPropuestasClasificacionPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerPendienteDesambiguacionPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerPendientesReclasificacionPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerGastosPendienteDatosPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerResolucionesContactoPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerPropuestasGastoPorChat(chatId).catch(() => NO_VERIFICADO),
    // El store más común de todos: un correo sin adjuntos que solo necesita "Proceder/Descartar/
    // Guardar/Dar instrucciones" — hallazgo real de auditoría: faltaba en la primera versión, así que
    // CUALQUIER correo simple ya resuelto/esperando respuesta por este camino se habría marcado
    // "atascado" por error, generando una propuesta duplicada real cada vez que este vigilante corriera.
    obtenerPropuestasAccionCorreoPorChat(chatId).catch(() => NO_VERIFICADO),
    // Caso real reportado por Carlos (2026-09-08): un gasto YA creado (así que su propuesta en
    // gastoProposalSheet ya se consumió/borró) puede quedar esperando SOLO la respuesta a "¿Quieres
    // que intente conciliar...?" — si Carlos tarda más de UMBRAL_ATASCADO_MS en contestar (revisando
    // un lote largo de correos, uno por uno), el vigilante no veía ninguna señal de entrega para ese
    // correo y lo daba por atascado, forzando un reintento que reprocesaba el mismo correo y generaba
    // una SEGUNDA pregunta de conciliación duplicada — la primera quedaba huérfana (sus botones ya no
    // corresponden a nada activo) justo cuando Carlos estaba por contestarla. "leíste y me enviaste 2
    // mails al mismo tiempo y uno ha quedado inactivo."
    obtenerConciliacionesPendientesPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerConciliacionesAmbiguasPendientesPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerPendientesOrientacionCorreoPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerOfertasResponderCorreoPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerBorradoresCorreoPorChat(chatId).catch(() => NO_VERIFICADO),
    obtenerPendientesCapturaEmpresaPorChat(chatId).catch(() => NO_VERIFICADO),
  ]);

  if (resultados.some((r) => r === NO_VERIFICADO)) return undefined;

  const [
    clasifs,
    desambiguaciones,
    reclasifs,
    gastosDatos,
    contactos,
    gastos,
    accionesCorreo,
    conciliaciones,
    conciliacionesAmbiguas,
    orientacionesCorreo,
    ofertasResponder,
    borradoresCorreo,
    capturasEmpresa,
  ] = resultados as [
    Awaited<ReturnType<typeof obtenerPropuestasClasificacionPorChat>>,
    Awaited<ReturnType<typeof obtenerPendienteDesambiguacionPorChat>>,
    Awaited<ReturnType<typeof obtenerPendientesReclasificacionPorChat>>,
    Awaited<ReturnType<typeof obtenerGastosPendienteDatosPorChat>>,
    Awaited<ReturnType<typeof obtenerResolucionesContactoPorChat>>,
    Awaited<ReturnType<typeof obtenerPropuestasGastoPorChat>>,
    Awaited<ReturnType<typeof obtenerPropuestasAccionCorreoPorChat>>,
    Awaited<ReturnType<typeof obtenerConciliacionesPendientesPorChat>>,
    Awaited<ReturnType<typeof obtenerConciliacionesAmbiguasPendientesPorChat>>,
    Awaited<ReturnType<typeof obtenerPendientesOrientacionCorreoPorChat>>,
    Awaited<ReturnType<typeof obtenerOfertasResponderCorreoPorChat>>,
    Awaited<ReturnType<typeof obtenerBorradoresCorreoPorChat>>,
    Awaited<ReturnType<typeof obtenerPendientesCapturaEmpresaPorChat>>,
  ];

  return (
    // Ambos stores escriben primero una fila provisional y después publican
    // Telegram. messageId=0 no prueba entrega: el operador nunca vio botones.
    clasifs.some((p) => p.messageId !== 0 && coincide(p.correoOrigen)) ||
    desambiguaciones.some((d) =>
      ((d as typeof d & { messageId?: number }).messageId ?? 0) !== 0 && coincide(d.correoOrigen)
    ) ||
    reclasifs.some((p) => coincide(p.correoOrigen)) ||
    gastosDatos.some((p) => coincide({ ...(p.correoOrigen ?? {}), deColaCorreo: p.deColaCorreo })) ||
    contactos.some((c) => coincide({
      ...(c.propuesta.correoOrigen ?? {}),
      deColaCorreo: c.propuesta.deColaCorreo,
    })) ||
    // messageId !== 0 — hallazgo real en vivo (2026-09-07): crearPropuestaGasto guarda la propuesta
    // en Sheets con messageId=0 ANTES de mandar el mensaje real de Telegram; si algo interrumpe el
    // proceso justo entre esos dos pasos, la propuesta queda huérfana — existe, referencia este
    // mismo correo, pero Carlos nunca vio nada. Contar esa existencia sola como "señal de entrega"
    // le habría dicho al vigilante "no está atascado, solo espera respuesta" sobre algo que en
    // realidad nunca llegó a mostrarse — exactamente el caso real que esto existe para atrapar.
    gastos.some((g) =>
      g.messageId !== 0 && coincide({ ...(g.correoOrigen ?? {}), deColaCorreo: g.deColaCorreo })
    ) ||
    // messageId !== 0 (mismo hallazgo que arriba, nunca se había aplicado acá) Y deColaCorreo (hallazgo
    // real de auditoría, 2026-09-09): revisarCorreoNuevo.ts ahora TAMBIÉN puede crear una
    // PropuestaAccionCorreo informativa para un correo CON adjuntos (detecta si el cuerpo pide algo
    // más allá de "aquí está el documento") — esa propuesta se manda ANTES del loop que procesa cada
    // adjunto como posible gasto, y se marca a propósito con deColaCorreo:false (nunca cuenta como una
    // de las decisiones reales que establecerPendientesActivo reserva por adjunto). Sin este filtro,
    // esa señal temprana e informativa bastaba para que el vigilante concluyera "no está atascado" —
    // aunque el loop de adjuntos (la parte que de verdad puede colgarse: descarga, lectura con visión)
    // ni siquiera hubiera empezado. Solo una propuesta de la COLA real (deColaCorreo:true) confirma que
    // se cumplió la obligación completa de este correo.
    accionesCorreo.some((a) =>
      a.messageId !== 0 &&
      coincideDecisionCorreoDeCola(
        { deColaCorreo: a.deColaCorreo, mensajeId: a.mensajeId, threadId: a.threadId },
        mensajeId,
        threadId
      )
    ) ||
    // Las filas legacy de ambas conciliaciones no tenían threadId. Siguen
    // siendo legibles/respondibles, pero no silencian el watchdog: solo una
    // decisión nueva con ownership y ambos ids exactos prueba que ESTE correo
    // activo está esperando al operador.
    conciliaciones.some((c) => coincideDecisionCorreoDeCola(
      { deColaCorreo: c.deColaCorreo, mensajeId: c.mensajeIdGmail, threadId: c.threadIdGmail },
      mensajeId,
      threadId
    )) ||
    conciliacionesAmbiguas.some((c) => coincideDecisionCorreoDeCola(
      { deColaCorreo: c.deColaCorreo, mensajeId: c.mensajeIdGmail, threadId: c.threadIdGmail },
      mensajeId,
      threadId
    )) ||
    orientacionesCorreo.some((o) => coincideDecisionCorreoDeCola(
      { deColaCorreo: o.deColaCorreo, mensajeId: o.mensajeId, threadId: o.threadId },
      mensajeId,
      threadId
    )) ||
    ofertasResponder.some((o) => o.messageId !== 0 && coincideDecisionCorreoDeCola(
      { deColaCorreo: o.deColaCorreo, mensajeId: o.correoMensajeId, threadId: o.correoThreadId },
      mensajeId,
      threadId
    )) ||
    borradoresCorreo.some((b) => b.messageId !== 0 && coincideDecisionCorreoDeCola(
      { deColaCorreo: b.deColaCorreo, mensajeId: b.correoMensajeId, threadId: b.correoThreadId },
      mensajeId,
      threadId
    )) ||
    capturasEmpresa.some((c) => coincideDecisionCorreoDeCola(
      { deColaCorreo: c.deColaCorreo, mensajeId: c.mensajeId, threadId: c.threadId },
      mensajeId,
      threadId
    ))
  );
}

