import { sendTelegramMessage } from "../telegram/client";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { obtenerActivoEstancado, descartarActivoEstancado, reencolarActivoParaReintento } from "../gmail/colaRevisionStore";
import { obtenerUltimoMensajeDeHilo } from "../gmail/client";
import { procesarSiguienteCorreoActivo } from "./revisarCorreoNuevo";
import { obtenerPropuestasClasificacionPorChat } from "../documental/classificationStore";
import { obtenerPendienteDesambiguacionPorChat } from "../documental/disambiguationStore";
import { obtenerPendientesReclasificacionPorChat } from "../documental/pendienteReclasificacionStore";
import { obtenerGastosPendienteDatosPorChat } from "../gastos/gastoPendienteDatosStore";
import { obtenerResolucionesContactoPorChat } from "../gastos/contactoResolucionStore";
import { obtenerPropuestasGastoPorChat } from "../gastos/gastoProposalSheet";
import { obtenerPropuestasAccionCorreoPorChat } from "../gmail/emailActionStore";

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
const reintentosPorGmailId = new Map<string, number>();

/**
 * `undefined` = no se pudo verificar (algún store falló al leer) — hallazgo real de auditoría: antes
 * cada chequeo se tragaba su propio error y lo trataba como "no hay evidencia", así que un error de
 * lectura transitorio en Sheets sesgaba la conclusión hacia "está atascado" y disparaba un reintento
 * real (con costo de API) sobre algo que en realidad no se pudo verificar — nunca debe reintentar por
 * no haber podido comprobar, solo por haber comprobado de verdad que no hay nada.
 */
async function huboSenalDeEntrega(chatId: number, mensajeId: string): Promise<boolean | undefined> {
  const coincide = (co: { mensajeIdGmail?: string } | undefined) => co?.mensajeIdGmail === mensajeId;

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
  ]);

  if (resultados.some((r) => r === NO_VERIFICADO)) return undefined;

  const [clasifs, desambiguaciones, reclasifs, gastosDatos, contactos, gastos, accionesCorreo] = resultados as [
    Awaited<ReturnType<typeof obtenerPropuestasClasificacionPorChat>>,
    Awaited<ReturnType<typeof obtenerPendienteDesambiguacionPorChat>>,
    Awaited<ReturnType<typeof obtenerPendientesReclasificacionPorChat>>,
    Awaited<ReturnType<typeof obtenerGastosPendienteDatosPorChat>>,
    Awaited<ReturnType<typeof obtenerResolucionesContactoPorChat>>,
    Awaited<ReturnType<typeof obtenerPropuestasGastoPorChat>>,
    Awaited<ReturnType<typeof obtenerPropuestasAccionCorreoPorChat>>,
  ];

  return (
    clasifs.some((p) => coincide(p.correoOrigen)) ||
    desambiguaciones.some((d) => coincide(d.correoOrigen)) ||
    reclasifs.some((p) => coincide(p.correoOrigen)) ||
    gastosDatos.some((p) => coincide(p.correoOrigen)) ||
    contactos.some((c) => coincide(c.propuesta.correoOrigen)) ||
    // messageId !== 0 — hallazgo real en vivo (2026-09-07): crearPropuestaGasto guarda la propuesta
    // en Sheets con messageId=0 ANTES de mandar el mensaje real de Telegram; si algo interrumpe el
    // proceso justo entre esos dos pasos, la propuesta queda huérfana — existe, referencia este
    // mismo correo, pero Carlos nunca vio nada. Contar esa existencia sola como "señal de entrega"
    // le habría dicho al vigilante "no está atascado, solo espera respuesta" sobre algo que en
    // realidad nunca llegó a mostrarse — exactamente el caso real que esto existe para atrapar.
    gastos.some((g) => coincide(g.correoOrigen) && g.messageId !== 0) ||
    accionesCorreo.some((a) => a.mensajeId === mensajeId)
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
  // obtenerActivoEstancado ya hace exactamente "¿hay un activo Y lleva más de X ms así?" — se
  // reutiliza en vez de reimplementar la misma comparación a mano por segunda vez en este archivo.
  const activo = await obtenerActivoEstancado(chatId, UMBRAL_ATASCADO_MS);
  if (!activo) return;

  const señal = await huboSenalDeEntrega(chatId, activo.mensajeId);
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
    reintentosPorGmailId.delete(activo.id);
    return;
  }

  const intentos = reintentosPorGmailId.get(activo.id) ?? 0;

  if (intentos >= MAX_REINTENTOS_AUTOMATICOS) {
    reintentosPorGmailId.delete(activo.id);
    // Se libera el bloqueo (nunca se marca leído: no se le llegó a mostrar nada a Carlos, así que no
    // se puede dar por resuelto) — a propósito NO se reencola de inmediato, para no repetir el mismo
    // ciclo fallido cada 2 minutos para siempre. Sigue sin leer en Gmail, así que la próxima revisión
    // horaria normal lo vuelve a encontrar solo.
    await descartarActivoEstancado(chatId, activo.id).catch((error) =>
      console.error(`[vigilarProcesamientoAtascado] Error liberando el bloqueo tras agotar reintentos (chat ${chatId}, id ${activo.id}):`, error)
    );
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

  const ultimo = await obtenerUltimoMensajeDeHilo(activo.id).catch(() => undefined);
  const reencolado = await reencolarActivoParaReintento(chatId, activo.id, {
    mensajeId: ultimo?.messageId ?? activo.mensajeId,
    de: ultimo?.de ?? activo.de,
    asunto: ultimo?.asunto ?? activo.asunto,
  });
  if (!reencolado) return; // se resolvió solo justo antes (ej. Carlos lo contestó en el instante) — no reintentar sobre algo que ya no existe.

  reintentosPorGmailId.set(activo.id, intentos + 1);

  await procesarSiguienteCorreoActivo(chatId);
}
