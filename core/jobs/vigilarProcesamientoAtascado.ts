import { sendTelegramMessage } from "../telegram/client";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import {
  obtenerActivoEstancado,
  descartarActivoEstancado,
  reencolarActivoParaReintento,
  confirmarActivoResueltoTrasMarcarLeido,
  coincideIdentidadCorreoCola,
} from "../gmail/colaRevisionStore";
import { marcarMensajeComoLeido } from "../gmail/client";
import { conCoordinadorCorreo } from "../gmail/automatico/postgres";
import { procesarSiguienteCorreoActivoYaCoordinado } from "./revisarCorreoNuevo";
import { obtenerPropuestasClasificacionPorChat } from "../documental/classificationStore";
import { obtenerPendienteDesambiguacionPorChat } from "../documental/disambiguationStore";
import { obtenerPendientesReclasificacionPorChat } from "../documental/pendienteReclasificacionStore";
import { obtenerGastosPendienteDatosPorChat } from "../gastos/gastoPendienteDatosStore";
import { obtenerResolucionesContactoPorChat } from "../gastos/contactoResolucionStore";
import { obtenerPropuestasGastoPorChat } from "../gastos/gastoProposalSheet";
import { obtenerPropuestasAccionCorreoPorChat } from "../gmail/emailActionStore";
import { obtenerConciliacionesPendientesPorChat } from "../gastos/conciliacionPendienteStore";
import { obtenerConciliacionesAmbiguasPendientesPorChat } from "../gastos/conciliacionAmbiguaPendienteStore";
import { obtenerPendientesOrientacionCorreoPorChat } from "../gmail/emailOrientationStore";
import { obtenerOfertasResponderCorreoPorChat } from "../gmail/emailReplyOfferStore";
import { obtenerBorradoresCorreoPorChat } from "../gmail/emailDraftStore";
import { hayActividadCallbackReciente } from "../telegram/callbackActivity";
import { obtenerPendientesCapturaEmpresaPorChat } from "../knowledge/pendienteCapturaEmpresaStore";

/**
 * Caso real reportado por Carlos (2026-09-07): un correo quedó "activo" más de 7 minutos sin que
 * Wobi mandara NADA al chat ni registrara ningún error — atascado a mitad de proceso (probablemente
 * una llamada externa lenta puntual). Solo se detectó porque Carlos avisó y yo lo diagnostiqué a
 * mano, con el chat esperando todo ese tiempo. Pedido explícito: "asegúrate que el sistema identifica
 * todos estos errores... de manera inmediata, con su... sistema de autodiagnóstico, y lo corrija
 * inmediatamente para que no nos quedemos esperando una respuesta."
 *
 * Este job corre cada pocos minutos (protegido contra solapamiento consigo mismo por
 * ejecutarSinSolapamiento en scheduler.ts) y busca el mismo patrón: un correo "activo" desde hace más
 * de UMBRAL_ATASCADO_MS SIN que exista ninguna señal real de que se le mandó algo a Carlos por
 * NINGUNO de los caminos reales que puede tomar un correo entrante (propuesta simple de
 * "Proceder/Descartar" para un correo sin adjuntos — el camino MÁS común —, propuesta de
 * clasificación de documento, pregunta de desambiguación, reclasificación pendiente, gasto con datos
 * pendientes, resolución de contacto, o propuesta de gasto — CUALQUIERA de estos que referencie el
 * mismo mensajeIdGmail confirma que sí se llegó a mandar algo, así que NO está atascado, solo
 * esperando la respuesta de Carlos, que puede tardar horas sin ser un bug). Se comparan TODAS las
 * pendientes de cada tipo para ese chat, no solo la más reciente — un chat puede tener más de una
 * pendiente del mismo tipo a la vez (ver disambiguationStore.ts, corregido hoy mismo por el mismo
 * motivo), así que quedarse con "la más reciente" podía mirar la pendiente equivocada.
 *
 * Si de verdad no hay ninguna señal, se asume un fallo transitorio de la llamada externa que se
 * quedó a mitad de camino (mismo diagnóstico confirmado a mano: un reintento limpio del mismo correo
 * terminó en segundos) — se saca de "activo" y se vuelve a poner en "cola" en UN solo paso
 * (reencolarActivoParaReintento, nunca borra-y-recrea — ver su comentario), preservando su fechaOrden
 * original, y se reintenta de inmediato, en silencio, hasta MAX_REINTENTOS_AUTOMATICOS veces.
 *
 * Si se agotan los reintentos sin éxito, es probable un problema real (no transitorio) — se avisa a
 * Carlos explícitamente y se libera el bloqueo (descartarActivoEstancado, sin marcar leído en Gmail:
 * nunca se le llegó a mostrar nada, así que no se puede dar por resuelto). A propósito NO se
 * reencola de inmediato tras agotar los reintentos — eso solo repetiría el mismo ciclo fallido cada
 * 2 minutos para siempre. Como no se marca leído, Gmail lo sigue contando como sin leer, así que la
 * próxima revisión horaria normal (revisarCorreoNuevo.ts) lo vuelve a encontrar solo, dándole un
 * enfriamiento natural de hasta una hora antes del próximo intento.
 */
const UMBRAL_ATASCADO_MS = 3 * 60 * 1000;
const MAX_REINTENTOS_AUTOMATICOS = 2;

// En memoria — se resetea si el proceso se reinicia (aceptable: en el peor caso da una vida extra de
// reintentos a algo que ya venía fallando; el umbral de tiempo de arriba sigue aplicando en cada
// corrida, así que nunca reintenta más rápido de lo previsto, solo eventualmente unas veces de más).
// Se limpia apenas se confirma que un hilo ya no está atascado (huboSenalDeEntrega=true), para que un
// hilo que vuelva a atascarse semanas después, en un incidente totalmente distinto, no herede el
// conteo de uno viejo ya resuelto.
const reintentosPorCorreoExacto = new Map<string, number>();

/** La unidad de recuperación es un mensaje, no el hilo completo. */
export function claveReintentoWatchdog(threadId: string, mensajeId: string): string {
  return `${threadId}:${mensajeId}`;
}

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
async function huboSenalDeEntrega(chatId: number, mensajeId: string, threadId: string): Promise<boolean | undefined> {
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

/** Corre por cada admin — busca un correo "activo" atascado y lo recupera automáticamente si puede. */
export async function vigilarProcesamientoAtascado(): Promise<void> {
  const admins = await obtenerAdmins();

  for (const admin of admins) {
    try {
      await vigilarUnChat(admin.userId);
    } catch (error) {
      console.error(`[vigilarProcesamientoAtascado] Error vigilando el chat ${admin.userId}:`, error);
    }
  }
}

async function vigilarUnChat(chatId: number): Promise<void> {
  // La inspección, la decisión, la mutación de la cola y el reintento forman
  // una sola transacción lógica del buzón. El mismo coordinador protege OCR,
  // Claude, callbacks y revisiones manuales/cron: si alguno sigue trabajando,
  // el watchdog espera o abandona por timeout; jamás arranca otro procesamiento
  // del mismo correo en paralelo.
  return conCoordinadorCorreo(() => vigilarUnChatYaCoordinado(chatId));
}

async function vigilarUnChatYaCoordinado(chatId: number): Promise<void> {
  // Un botón puede consumir su propuesta antes de terminar la creación/conciliación y el cierre de
  // la cola. Durante esa transición no queda ninguna de las señales de huboSenalDeEntrega, pero sí
  // hay trabajo legítimo en curso. Reprocesar el correo en paralelo fue la causa real de avisos
  // duplicados y de un lock_timeout al intentar cerrar la misma cola desde el callback.
  if (hayActividadCallbackReciente(chatId)) return;

  // obtenerActivoEstancado ya hace exactamente "¿hay un activo Y lleva más de X ms así?" — se
  // reutiliza en vez de reimplementar la misma comparación a mano por segunda vez en este archivo.
  const activo = await obtenerActivoEstancado(chatId, UMBRAL_ATASCADO_MS);
  if (!activo) return;

  // pendientes=0 significa que la decisión terminal ya quedó persistida y
  // solo falló el último paso Gmail→confirmación local. Reprocesar en este
  // estado repetiría trabajo financiero ya terminado. El vigilante completa
  // únicamente el cierre exacto y nunca revive el análisis del correo.
  const identidadActiva = { threadId: activo.id, mensajeId: activo.mensajeId };
  const claveReintento = claveReintentoWatchdog(activo.id, activo.mensajeId);
  if (activo.pendientesRestantes === 0) {
    if (!coincideIdentidadCorreoCola(activo, identidadActiva)) return;
    reintentosPorCorreoExacto.delete(claveReintento);
    const marcado = await marcarMensajeComoLeido(activo.mensajeId).catch((error) => {
      console.error(`[vigilarProcesamientoAtascado] No se pudo reintentar Gmail READ (chat ${chatId}):`, error);
      return false;
    });
    if (marcado) await confirmarActivoResueltoTrasMarcarLeido(chatId, identidadActiva);
    return;
  }

  const señal = await huboSenalDeEntrega(chatId, activo.mensajeId, activo.id);
  if (señal === undefined) {
    // No se pudo verificar (algún store falló al leer) — nunca se actúa sobre una duda, se reintenta
    // solo en la próxima corrida cuando de verdad se pueda confirmar.
    console.error(`[vigilarProcesamientoAtascado] No se pudo verificar el chat ${chatId} esta corrida (error de lectura) — se reintenta en la próxima.`);
    return;
  }
  if (señal) {
    // Sí se mandó algo — está esperando la respuesta de Carlos, no atascado. Se limpia cualquier
    // conteo de reintentos viejo (si lo hubo) para que no se herede en un futuro incidente no
    // relacionado con el mismo hilo.
    reintentosPorCorreoExacto.delete(claveReintento);
    return;
  }

  // La interacción puede haber empezado mientras se consultaban los ocho stores de arriba. Esta
  // segunda comprobación cierra esa carrera antes de tocar el estado durable de la cola.
  if (hayActividadCallbackReciente(chatId)) return;

  const intentos = reintentosPorCorreoExacto.get(claveReintento) ?? 0;

  if (intentos >= MAX_REINTENTOS_AUTOMATICOS) {
    reintentosPorCorreoExacto.delete(claveReintento);
    // Se libera el bloqueo (nunca se marca leído: no se le llegó a mostrar nada a Carlos, así que no
    // se puede dar por resuelto) — a propósito NO se reencola de inmediato, para no repetir el mismo
    // ciclo fallido cada 2 minutos para siempre. Sigue sin leer en Gmail, así que la próxima revisión
    // horaria normal lo vuelve a encontrar solo.
    const descartado = await descartarActivoEstancado(chatId, {
      threadId: activo.id,
      mensajeId: activo.mensajeId,
    }).catch((error) => {
      console.error(`[vigilarProcesamientoAtascado] Error liberando el bloqueo tras agotar reintentos (chat ${chatId}, id ${activo.id}):`, error);
      return false;
    });
    if (!descartado) return;
    await sendTelegramMessage(
      chatId,
      `⚠️ "${activo.asunto}" (de ${activo.de}) lleva atascado varios minutos sin que lograra procesarlo, incluso después de ` +
        `${MAX_REINTENTOS_AUTOMATICOS} reintentos automáticos — probablemente no sea algo transitorio. Lo liberé para que no bloquee ` +
        `el resto de la cola (sigue sin marcar como leído en Gmail, no se perdió) — la próxima revisión horaria lo vuelve a intentar ` +
        `solo. Avísame si quieres que lo revise a fondo mientras tanto.`
    ).catch(() => {});
    return;
  }

  console.error(
    `[vigilarProcesamientoAtascado] Correo activo atascado detectado (chat ${chatId}, id ${activo.id}, "${activo.asunto}") — ` +
      `reintento automático ${intentos + 1}/${MAX_REINTENTOS_AUTOMATICOS}.`
  );

  const reencolado = await reencolarActivoParaReintento(chatId, {
    threadId: activo.id,
    mensajeId: activo.mensajeId,
  }, {
    de: activo.de,
    asunto: activo.asunto,
  });
  if (!reencolado) {
    reintentosPorCorreoExacto.delete(claveReintento);
    return; // se resolvió o cambió justo antes; nunca reintentar sobre otra identidad.
  }

  reintentosPorCorreoExacto.set(claveReintento, intentos + 1);

  await procesarSiguienteCorreoActivoYaCoordinado(chatId);
}
