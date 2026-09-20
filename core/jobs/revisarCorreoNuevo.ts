import { buscarAnalisisAutomaticoReciente, conCoordinadorCorreo } from "../gmail/automatico/postgres";
import { revisarGastosAutomaticos, comprobarCorreoDisponible } from "../gmail/automatico/runtime";
import { resumenAutomatico } from "../gmail/automatico/service";
import { reutilizarGastoDeAnalisisAutomatico } from "../gmail/automatico/reutilizarAnalisis";
import type { ModoAuto, ResultadoAuto } from "../gmail/automatico/model";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listarHilosNoLeidos,
  obtenerPrimerMensajeNoLeidoDeHilo,
  marcarMensajeComoLeido,
  obtenerResumenCorreo,
  obtenerCuerpoCompletoCorreo,
  obtenerHtmlVisualCorreo,
  descargarAdjunto,
  buscarMensajes,
  extraerDireccionCorreo,
  type CorreoResumen,
} from "../gmail/client";
import { analizarCorreo } from "../gmail/classifyEmail";
import { extraerGastoDeCorreo } from "../gmail/extraerGastoDeCorreo";
import { generarComprobantePDF } from "../gmail/generarComprobantePDF";
import { guardarUltimoCheck } from "../gmail/lastCheckStore";
import { listarContactosAutorespuesta } from "../gmail/autorespuestaContactoStore";
import { listarHilosAutorespuesta } from "../gmail/hiloAutorespuestaStore";
import { esDiaHabilEspana } from "../utils/diaHabil";
import { yaSeAvisoHoy, marcarAvisadoHoy } from "./avisoUnicoPorDiaStore";
import { sendTelegramMessage, sendTelegramMessageWithButtons, sendTelegramMessageSmart, answerCallbackQuery, editTelegramMessageReplyMarkup } from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { procesarDocumentoLocal } from "../documental/procesarDocumentoLocal";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import { mapearConConcurrencia } from "../utils/mapearConConcurrencia";
import { debeEjecutarAnalisisAutomatico, debePublicarInformeCorreo,
  type SolicitudRevisionCorreo } from "./politicaRevisionCorreo";
import { marcarInformeCronPublicado, prepararInformeCron, registrarRevisionCron,
  reservarSlotInformeCron } from "../gmail/automatico/reportes";
import type { DatosFactura } from "../documental/extractInvoiceData";
import {
  crearPropuestaAccionCorreo,
  actualizarMessageIdAccionCorreo,
  consumirPropuestaAccionCorreo,
  restaurarPropuestaAccionCorreo,
  type PropuestaAccionCorreo,
} from "../gmail/emailActionStore";
import { registrarPersonaDesdeCorreo } from "../directorio/directorioPersonasSheet";
import { buscarGastoDesdeCorreo } from "../gastos/gastoPorCorreoStore";
import { revalidarRegistroRecienteDeCorreo } from "../gastos/verificarGastoPorCorreo";
import { yaSeArchivoDesdeCorreo } from "../documental/documentoArchivadoPorCorreoStore";
import {
  encolarCorreos,
  hayActivo,
  contarPendientesTotal,
  iniciarSiguienteActivo,
  establecerPendientesActivo,
  incrementarPendientesActivo,
  revertirIncrementoPendientesActivo,
  resolverUnoActivo,
  obtenerActivoEstancado,
  descartarActivoEstancado,
  obtenerActivoActual,
  confirmarActivoResueltoTrasMarcarLeido,
  prepararCierreExplicitoActivo,
  reintentarActivoPendienteDeMarcarLeido,
  type IdentidadCorreoCola,
} from "../gmail/colaRevisionStore";

// 48h — mismo criterio que classificationStore.ts (48h) y otras propuestas
// "principales" del sistema: suficiente margen para un día de trabajo largo
// o una respuesta demorada, sin dejar la cola trabada indefinidamente.
const UMBRAL_ACTIVO_ESTANCADO_MS = 48 * 60 * 60 * 1000;

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");
const TEMA_AVISO_CORREO_PENDIENTE = "correo_nuevo_pendiente";
const PREFIJO_REINTENTO_TECNICO = "__reintento_tecnico__:";

type AlcanceReintentoTecnico = "correo" | "cuerpo" | `adjunto:${string}`;

function alcanceReintentoDePropuesta(propuesta: PropuestaAccionCorreo): AlcanceReintentoTecnico | undefined {
  if (!propuesta.accionSugerida.startsWith(PREFIJO_REINTENTO_TECNICO)) return undefined;
  const alcance = propuesta.accionSugerida.slice(PREFIJO_REINTENTO_TECNICO.length);
  if (alcance === "correo" || alcance === "cuerpo" || alcance.startsWith("adjunto:")) {
    return alcance as AlcanceReintentoTecnico;
  }
  return undefined;
}

function botonesReintentoTecnico(id: string, alcance: AlcanceReintentoTecnico) {
  return [
    [{ text: "🔄 Reintentar", callback_data: `colacorreo_reintentar:${id}` }],
    [{
      text: alcance === "correo" ? "🗑️ Descartar correo y marcar leído" : "🗑️ Descartar esta parte",
      callback_data: alcance === "correo" ? "colacorreo_descartaractivo" : `email_descartar:${id}`,
    }],
  ];
}

/**
 * Convierte un fallo técnico en una decisión durable y visible. La fila usa
 * el mismo store transaccional de las acciones de correo: un doble toque solo
 * puede reclamarla una vez y la identidad exacta impide que cierre otro mail.
 * No suma contador: sustituye la unidad que no alcanzó a producir su propuesta.
 */
async function publicarReintentoTecnico(
  chatId: number,
  correo: Pick<CorreoResumen, "de" | "asunto" | "threadId" | "messageIdHeader" | "id">,
  alcance: AlcanceReintentoTecnico,
  detalle: string
): Promise<void> {
  const propuesta = await crearPropuestaAccionCorreo({
    chatId,
    messageId: 0,
    de: correo.de,
    asunto: correo.asunto || "(sin asunto)",
    tipo: "instruccion_jefe",
    resumen: detalle,
    accionSugerida: `${PREFIJO_REINTENTO_TECNICO}${alcance}`,
    threadId: correo.threadId,
    messageIdHeader: correo.messageIdHeader,
    mensajeId: correo.id,
    deColaCorreo: true,
  });

  let messageId: number;
  try {
    messageId = await sendTelegramMessageWithButtons(
      chatId,
      `${detalle}\n\nEl correo permanece *sin leer*. Puedes reintentar esta parte o descartarla explícitamente.`,
      botonesReintentoTecnico(propuesta.id, alcance)
    );
  } catch (error) {
    await consumirPropuestaAccionCorreo(propuesta.id).catch(() => undefined);
    throw error;
  }

  // Los botones ya son visibles y llevan el id durable. No duplicarlos por
  // un fallo secundario al persistir el messageId de Telegram.
  await actualizarMessageIdAccionCorreo(propuesta.id, messageId).catch((error) =>
    console.error("[revisarCorreoNuevo] Reintento publicado; no se pudo guardar su messageId:", error)
  );
}

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
}

/**
 * Pedido explícito de Carlos, tras un caso real: cuando revisaba el correo,
 * el sistema mandaba una propuesta por CADA correo nuevo de la misma
 * pasada — con varios correos a la vez, eso eran varias propuestas de golpe
 * ("necesitamos organizar este proceso"). Ahora, en vez de procesar todo de
 * una, esta función solo ENCOLA (core/gmail/colaRevisionStore.ts) los
 * correos sin leer nuevos — del más antiguo al más nuevo — y, si no hay
 * ningún correo "activo" en este momento (nada mostrado esperando
 * resolución), arranca con el más antiguo. El resto de la cola se procesa
 * de a uno, avanzando solo cuando cada correo se resuelve en el chat (ver
 * avanzarColaCorreoSiActivo, llamado desde los botones de acción/captura/
 * clasificación de documento/gasto ya existentes en el resto del sistema).
 *
 * A diferencia de antes, la fuente de verdad de "correo nuevo" es is:unread
 * real de Gmail, por HILO (listarHilosNoLeidos), no una marca de tiempo
 * propia ni un conteo por mensaje individual — así
 * "cuántos correos sin leer quedan" siempre refleja el estado real de la
 * bandeja, y un correo que Carlos ya leyó a mano en Gmail no vuelve a
 * aparecer en la cola.
 */
export interface ResultadoRevisarCorreo {
  correosRevisados: number;
  automatico?: ResultadoAuto;
  /** Indica si esta misma ejecución ya publicó su resumen en Telegram. */
  informePublicado?: boolean;
  /**
   * Cuando correosRevisados=0 porque ya había un correo "activo" sin
   * resolver (no porque no hubiera nada pendiente) — para que el llamador
   * (comando manual /revisarcorreo) pueda avisar QUÉ es lo que está
   * bloqueando, en vez de decir "0 correos revisados" sin explicación.
   * Pedido explícito de Carlos, tras un caso real: pidió /revisarcorreo con
   * varios correos reales sin leer, y el sistema respondió así sin ninguna
   * pista de que la causa real era una pregunta de conciliación pendiente
   * desde horas antes.
   */
  activoBloqueando?: { asunto: string; de: string };
}

/**
 * Pedido explícito de Carlos, tras un caso real: usa el MISMO chat para
 * hacer otras preguntas/averiguaciones mientras revisa el correo, y el
 * siguiente correo de la cola aparecía de golpe (con su propia propuesta y
 * botones) en medio de esas consultas, cruzándose con ellas — sin importar
 * si el avance venía de resolver el correo anterior, de saltar uno
 * estancado, o de retomar un backlog en la revisión horaria automática.
 * Los TRES puntos donde este archivo antes llamaba a
 * procesarSiguienteCorreoActivo directamente ahora pasan por acá: se
 * manda un aviso con un botón "▶️ Sí, siguiente" y NUNCA se muestra el
 * contenido real del siguiente correo hasta que se presiona — la cola
 * simplemente se queda sin nada "activo" mientras tanto (sin TTL propio;
 * el resumen diario de pendientes ya la reporta si se olvida).
 */
async function pedirConfirmacionSiguienteCorreo(chatId: number, mensaje: string): Promise<void> {
  await sendTelegramMessageSmart(chatId, mensaje, [
    [{ text: "▶️ Sí, siguiente", callback_data: "colacorreo_siguiente" }],
  ]);
}

/**
 * Las solicitudes manuales siempre reciben progreso y resultado. El cron separa los pases
 * silenciosos de los informes consolidados de las 10:00 y 18:00. La unión discriminada evita que
 * un booleano posicional confunda otra vez una orden del operador con una revisión programada.
 */
const revisionesEnCurso = new Map<number, Promise<ResultadoRevisarCorreo>>();
const revisionesInteractivas = new Set<number>();
export class RevisionCorreoOcupadaError extends Error {
  constructor() {
    super("Otra revisión mantiene el buzón ocupado. Vuelve a intentarlo en unos minutos.");
    this.name = "RevisionCorreoOcupadaError";
  }
}
function esTimeoutDeBloqueo(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "55P03";
}
function modoAutomaticoSeguro(): ModoAuto {
  if (process.env.WOBI_MAIL_AUTO_KILL_SWITCH === "true") return "off";
  const modo = process.env.WOBI_MAIL_AUTO_MODE;
  if (modo === "off") return "off";
  return modo === "simulate" ? "simulate" : "execute";
}
export async function revisarCorreoNuevo(
  solicitud: SolicitudRevisionCorreo
): Promise<ResultadoRevisarCorreo> {
  const forzarAviso = solicitud.origen === "manual";
  const chatIdSolicitante = solicitud.origen === "manual" ? solicitud.chatId : undefined;
  const chatId = chatIdSolicitante ?? (process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined);

  if (!chatId) {
    console.error("[revisarCorreoNuevo] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { correosRevisados: 0 };
  }
  const existente = revisionesEnCurso.get(chatId);
  if (existente) {
    if (forzarAviso) {
      revisionesInteractivas.add(chatId);
      await sendTelegramMessageSmart(chatId,
        "⏳ Ya había una revisión de correo en curso (posiblemente iniciada por el cron). Me uno a esa misma revisión para no duplicar trabajo; te informaré su avance y resultado."
      ).catch(() => {});
    }
    const resultado = await existente;
    // Cierra la carrera en la que una orden manual llega justo después de
    // que un cron silencioso decidió no publicar, pero antes de terminar.
    if (forzarAviso && !resultado.informePublicado && resultado.automatico) {
      const resumen = resumenAutomatico(resultado.automatico);
      if (resumen) {
        // Reservar antes del await evita que dos órdenes manuales que se
        // unan a la vez publiquen el mismo cierre dos veces.
        resultado.informePublicado = true;
        try {
          await sendTelegramMessageSmart(chatId, resumen);
        } catch (error) {
          resultado.informePublicado = false;
          throw error;
        }
      }
    }
    return resultado;
  }
  if (forzarAviso) revisionesInteractivas.add(chatId);
  const tarea = conCoordinadorCorreo(async () => {
    let automatico: ResultadoAuto;
    if (!debeEjecutarAnalisisAutomatico(solicitud)) {
      automatico = { modo: modoAutomaticoSeguro(), revisados: 0, completados: 0,
        simulados: 0, gastos: [], pendientes: [] };
    } else try {
      automatico = await revisarGastosAutomaticos(chatId, {
        informarProgreso: () => forzarAviso || revisionesInteractivas.has(chatId),
      });
    } catch (error) {
      const detalle = error instanceof Error ? error.message : "error no identificado";
      console.error("[revisarCorreoNuevo] La fase automática no pudo completarse; continúa la cola manual:", error);
      automatico = { modo: modoAutomaticoSeguro(), revisados: 0, completados: 0, simulados: 0, gastos: [],
        pendientes: [{ mensajeId: "sistema", asunto: "Fase automática incompleta",
          motivos: [`error_automatico:${detalle}`] }] };
    }
    let resultadoParaInforme = automatico;
    let revisionesConsolidadas: number | undefined;
    let slotInforme: string | undefined;
    let slotNoDisponible = false;
    if (solicitud.origen === "cron") {
      const revisionRegistrada = await registrarRevisionCron(automatico).catch(error => {
        console.error("[revisarCorreoNuevo] No se pudo registrar la revisión cron para el informe consolidado:", error);
        return false;
      });
      if (solicitud.informe === "consolidado") {
        const reserva = await reservarSlotInformeCron(solicitud.slot).catch(error => {
          console.error("[revisarCorreoNuevo] No se pudo reservar de forma segura el slot del informe; se suprime para evitar duplicados:", error);
          return undefined;
        });
        slotInforme = reserva?.slot;
        slotNoDisponible = !reserva?.reservado;
        if (reserva?.reservado) {
          const preparado = await prepararInformeCron(automatico, revisionRegistrada).catch(error => {
            console.error("[revisarCorreoNuevo] No se pudo preparar el informe consolidado; se suprime este slot para no perder el acumulado:", error);
            return undefined;
          });
          if (preparado) {
            resultadoParaInforme = preparado.resultado;
            revisionesConsolidadas = preparado.revisionesIncluidas;
          } else {
            slotNoDisponible = true;
          }
        }
      }
    }
    const resumen = resumenAutomatico(resultadoParaInforme,
      revisionesConsolidadas ? { revisionesConsolidadas } : undefined);
    console.log(`[correo-auto] Resultado final:\n${resumenAutomatico(automatico)}`);
    const cola = await sincronizarColaCorreo(
      forzarAviso,
      chatId,
      resumen,
      () => debePublicarInformeCorreo(solicitud, revisionesInteractivas.has(chatId), slotNoDisponible)
    );
    if (solicitud.origen === "cron" && solicitud.informe === "consolidado" &&
        cola.informePublicado && slotInforme && !slotNoDisponible) {
      await marcarInformeCronPublicado(slotInforme).catch(error =>
        console.error("[revisarCorreoNuevo] El informe salió, pero no se pudo registrar su slot:", error)
      );
    }
    return { ...cola, automatico };
  }, { lockTimeoutMs: forzarAviso ? 10 * 60_000 : 30_000 });
  revisionesEnCurso.set(chatId, tarea);
  try { return await tarea; } catch (error) {
    if (forzarAviso && esTimeoutDeBloqueo(error)) throw new RevisionCorreoOcupadaError();
    throw error;
  } finally {
    revisionesEnCurso.delete(chatId);
    revisionesInteractivas.delete(chatId);
  }
}

async function sincronizarColaCorreo(
  forzarAviso: boolean,
  chatId: number,
  resumenAuto: string,
  debePublicarInforme: () => boolean
): Promise<ResultadoRevisarCorreo> {
  let informePublicado = false;
  const publicarResumenSiCorresponde = async (): Promise<void> => {
    if (!informePublicado && resumenAuto && debePublicarInforme()) {
      await sendTelegramMessageSmart(chatId, resumenAuto);
      informePublicado = true;
    }
  };

  // Antes que cualquier otra cosa: si el correo activo ya tomó TODAS sus decisiones reales
  // (pendientesRestantes=0) pero se quedó sin confirmar por un fallo al marcarlo leído en Gmail la
  // vez anterior (ver resolverUnoActivo/confirmarActivoResueltoTrasMarcarLeido — caso real Eurohotel/
  // Avianca/Larrauri), se reintenta acá, en cada revisión, en vez de esperar 48h o requerir que
  // Carlos lo destrabe a mano — la mayoría de estos fallos son transitorios (cuota de Sheets/Gmail
  // agotada por unos minutos), así que un reintento normal minutos/horas después suele bastar.
  const pendienteDeConfirmar = await reintentarActivoPendienteDeMarcarLeido(chatId).catch((error) => {
    console.error("[revisarCorreoNuevo] Error revisando si hay un correo pendiente de confirmar leído:", error);
    return undefined;
  });
  if (pendienteDeConfirmar) {
    const marcado = await marcarMensajeComoLeido(pendienteDeConfirmar.mensajeId).catch((error: unknown) => {
      console.error("[revisarCorreoNuevo] Error reintentando marcar el mensaje como leído:", error);
      return false;
    });
    if (marcado) {
      await confirmarActivoResueltoTrasMarcarLeido(chatId, {
        threadId: pendienteDeConfirmar.id,
        mensajeId: pendienteDeConfirmar.mensajeId,
      }).catch((error) =>
        console.error("[revisarCorreoNuevo] Error confirmando el correo reintentado (no crítico):", error)
      );
    }
    // Si sigue fallando, se deja tal cual — el chequeo de "estancado" (48h) de abajo eventualmente lo
    // saltará con aviso si el fallo resulta ser persistente, no solo transitorio.
  }

  // Antes de encolar nada: si el correo activo lleva más de 48h esperando
  // algo que nunca llegó (una pregunta de desambiguación vencida, una
  // corrección de gasto que se quedó a medias...), lo salta con aviso en
  // vez de dejar toda la cola bloqueada detrás de él indefinidamente — ver
  // obtenerActivoEstancado.
  const estancado = await obtenerActivoEstancado(chatId, UMBRAL_ACTIVO_ESTANCADO_MS).catch((error) => {
    console.error("[revisarCorreoNuevo] Error revisando si el correo activo está estancado:", error);
    return undefined;
  });
  if (estancado) {
    const descartado = await descartarActivoEstancado(chatId, {
      threadId: estancado.id,
      mensajeId: estancado.mensajeId,
    }).catch((error) => {
      console.error("[revisarCorreoNuevo] Error descartando correo activo estancado:", error);
      return false;
    });
    if (descartado) {
      await sendTelegramMessage(
        chatId,
        `⚠️ "${estancado.asunto}" (de ${estancado.de}) llevaba más de 48h abierto sin resolverse — lo salto para no ` +
          `trabar el resto de la cola. Sigue sin marcar como leído en Gmail; revísalo a mano si todavía hace falta.`
      ).catch(() => {});
    }
    // Bug real encontrado en auditoría: acá antes también se mandaba su
    // propio aviso de "¿seguimos con el siguiente?" — pero más abajo, la
    // rama unificada (!habiaActivoAntes && quedan pendientes) SIEMPRE se
    // cumple justo después de esto (ya no queda nada "activo" tras el
    // descarte), así que Carlos recibía DOS avisos casi idénticos seguidos
    // por la misma razón. Se deja que sea la rama de abajo, única, la que
    // mande el aviso — ya contempla este caso sin necesidad de duplicar.
  }

  let ids: string[] = [];
  try {
    ids = await listarHilosNoLeidos();
  } catch (error) {
    console.error("[revisarCorreoNuevo] Error listando hilos sin leer:", error);
    // No sincronizar con una lista vacía inventada: si Gmail falló,
    // eliminaríamos de la cola correos que siguen realmente sin leer.
    const activo = await obtenerActivoActual(chatId).catch(() => undefined);
    await publicarResumenSiCorresponde();
    return {
      correosRevisados: 0,
      activoBloqueando: activo ? { asunto: activo.asunto, de: activo.de } : undefined,
      informePublicado,
    };
  }

  console.log(`[revisarCorreoNuevo] ${ids.length} hilo(s) sin leer en la bandeja`);

  // Ya no se usa para filtrar (is:unread real reemplazó la ventana de
  // tiempo) — se guarda solo para que estadoAgregado.ts (panel /cerebro)
  // pueda mostrar "última vez que se revisó el correo" sin quedar
  // congelado en el valor de antes de este cambio.
  guardarUltimoCheck(Math.floor(Date.now() / 1000)).catch((error) =>
    console.error("[revisarCorreoNuevo] Error guardando el último check (no crítico):", error)
  );

  const [habiaActivoAntes, totalAntesDeEncolar, contactos, estadosHilo] = await Promise.all([
    hayActivo(chatId),
    contarPendientesTotal(chatId),
    listarContactosAutorespuesta().catch((error) => {
      console.error("[revisarCorreoNuevo] No se pudo leer la lista de autorrespuesta; los hilos se conservarán en revisión manual:", error);
      return [];
    }),
    listarHilosAutorespuesta().catch((error) => {
      console.error("[revisarCorreoNuevo] No se pudo leer el estado de autorrespuesta; los hilos se conservarán en revisión manual:", error);
      return [];
    }),
  ]);
  const contactosAutorespuesta = new Set(contactos.map(contacto => contacto.email));
  const autorespuestaPorHilo = new Map(estadosHilo.map(estado => [estado.threadId, estado.estado]));

  const itemsParaEncolar: Array<{ id: string; mensajeId: string; de: string; asunto: string; fechaOrden: number }> = [];
  let metadatosCompletos = true;
  const metadatos = await mapearConConcurrencia(ids, 4, async threadId => {
    try {
      const primero = await obtenerPrimerMensajeNoLeidoDeHilo(threadId);
      if (!primero) {
        // No reconciliar/eliminar filas locales desde una fotografía a la
        // que le faltó un hilo real de Gmail.
        metadatosCompletos = false;
        return undefined;
      }

      // Pedido explícito de Carlos: la aprobación de conversación automática
      // (ver autorespuestaContactoStore.ts) es por CONTACTO, pero un mismo
      // contacto puede tener hilos que SÍ son automáticos y otros que no —
      // "no en todos debes responder automáticamente, solamente en el
      // identificado". Por eso la exclusión de acá es por HILO, no por
      // contacto entero: solo se excluye si ese hilo puntual está aprobado o
      // recién preguntándose (ver hiloAutorespuestaStore.ts) — su propio job,
      // más frecuente, ya lo está atendiendo. Un hilo del mismo contacto que
      // Carlos ya rechazó (o que todavía no se le preguntó) sigue entrando
      // acá con normalidad, para no dejarlo sin revisar nunca.
      if (contactosAutorespuesta.has(extraerDireccionCorreo(primero.de))) {
        const estadoHilo = autorespuestaPorHilo.get(threadId);
        if (estadoHilo === "aprobado" || estadoHilo === "pendiente") return undefined;
      }

      const fechaOrden = primero.recibidoEn;
      return {
        id: threadId,
        mensajeId: primero.messageId,
        de: primero.de,
        asunto: primero.asunto || "(sin asunto)",
        fechaOrden: Number.isFinite(fechaOrden) ? fechaOrden : Date.now(),
      };
    } catch (error) {
      metadatosCompletos = false;
      console.error(`[revisarCorreoNuevo] Error leyendo metadatos del hilo ${threadId} (se omite de la cola):`, error);
      return undefined;
    }
  });
  itemsParaEncolar.push(...metadatos.filter((item): item is NonNullable<typeof item> => Boolean(item)));

  // Se llama incluso con [] para reconciliar y retirar de la cola local los
  // hilos que ya no están sin leer en Gmail.
  const nuevos = await encolarCorreos(chatId, itemsParaEncolar, { reconciliarAusentes: metadatosCompletos });

  // Bug real encontrado en vivo: esto antes vivía DENTRO del `if (nuevos ===
  // 0) return` de arriba — un "revisarcorreo" manual con la cola ya llena
  // pero SIN nada "activo" (ej. justo después de resetear un correo
  // atascado) no encontraba nada NUEVO que encolar, así que la función
  // terminaba ahí ("0 correos revisados") sin nunca retomar lo que ya
  // estaba esperando. Ahora, sin importar si esta corrida encontró algo
  // nuevo, si no hay nada activo y sí hay algo pendiente (nuevo o de antes),
  // se avisa (con botón — nunca se muestra el siguiente correo directo, ver
  // pedirConfirmacionSiguienteCorreo).
  const totalPendienteTrasEncolar = await contarPendientesTotal(chatId);
  if (!habiaActivoAntes && totalPendienteTrasEncolar > 0) {
    const debeAvisar = debePublicarInforme() &&
      (forzarAviso || Boolean(resumenAuto) ||
        (esDiaHabilEspana() && !(await yaSeAvisoHoy(TEMA_AVISO_CORREO_PENDIENTE, chatId))));

    if (debeAvisar) {
      // Pedido explícito de Carlos: el aviso trae el conteo de "nuevos" solo
      // al EMPEZAR una revisión desde cero — si ya hay un backlog en curso, el
      // mensaje es más genérico (no repite "nuevo" sobre algo que ya se sabía
      // de una corrida anterior).
      const mensaje =
        nuevos > 0 && totalAntesDeEncolar === 0
          ? `📬 Tienes ${nuevos} correo${nuevos === 1 ? "" : "s"} nuevo${nuevos === 1 ? "" : "s"} sin leer — ¿empezamos por el más antiguo?`
          : `Quedan ${totalPendienteTrasEncolar} correo${totalPendienteTrasEncolar === 1 ? "" : "s"} sin leer por revisar — ¿seguimos?`;
      await pedirConfirmacionSiguienteCorreo(chatId, [resumenAuto, mensaje].filter(Boolean).join("\n\n"));
      informePublicado = Boolean(resumenAuto);
      // Se marca SIEMPRE, incluso si este envío fue forzado (/revisarcorreo, endpoint admin) — el
      // objetivo real es "nunca el mismo aviso dos veces el mismo día" sin importar qué lo disparó
      // primero. Hallazgo real de auditoría: antes solo se marcaba en el camino sin forzar, así que
      // un /revisarcorreo manual seguido más tarde por el cron horario (sin que Carlos llegara a
      // interactuar con la cola) podía mandar el MISMO aviso dos veces el mismo día.
      await marcarAvisadoHoy(TEMA_AVISO_CORREO_PENDIENTE, chatId);
    }
    return { correosRevisados: nuevos, informePublicado };
  }

  await publicarResumenSiCorresponde();

  if (habiaActivoAntes) {
    const activo = await obtenerActivoActual(chatId).catch(() => undefined);
    if (activo) {
      return { correosRevisados: nuevos, activoBloqueando: { asunto: activo.asunto, de: activo.de }, informePublicado };
    }
  }

  return { correosRevisados: nuevos, informePublicado };
}

/**
 * Núcleo de decisión para UN correo ya localizado (adjuntos reales →
 * clasificación de documento/gasto; sin adjuntos, primero intenta leerlo
 * como gasto en el cuerpo; si no, análisis genérico con propuesta+botones)
 * — usado tanto por el correo activo de la cola (procesarSiguienteCorreoActivo,
 * deColaCorreo=true) como por un correo puntual fuera de ella (pedido
 * explícito de Carlos: "vamos al correo de X, léelo" sin pasar por la cola
 * de más antiguo a más nuevo — ver revisarCorreoPuntual.ts,
 * deColaCorreo=false). `deColaCorreo` decide si las propuestas resultantes
 * avanzan colaRevisionStore al resolverse (ver deColaCorreo en
 * PropuestaGasto/PropuestaAccionCorreo/correoOrigen) — así un correo puntual
 * nunca toca ni confunde el correo activo real de la cola, si hay uno en
 * curso al mismo tiempo. El llamador es responsable de SU PROPIA bookkeeping
 * de cola (establecerPendientesActivo con el activo.id real) y de reportar
 * un error si esto lanza — acá solo se avanza la cola en los puntos donde
 * una rama termina SIN mandar ninguna propuesta real (gasto duplicado, error
 * leyendo un adjunto), y solo si deColaCorreo=true.
 */
interface OpcionesProcesamientoCorreo {
  /** Reintento de un único adjunto: no vuelve a publicar la solicitud independiente del cuerpo. */
  omitirSolicitudCuerpo?: boolean;
}

async function procesarCorreoLocalizado(
  chatId: number,
  correo: CorreoResumen,
  deColaCorreo: boolean,
  opciones: OpcionesProcesamientoCorreo = {}
): Promise<void> {
  const identidadCola: IdentidadCorreoCola = {
    threadId: correo.threadId,
    mensajeId: correo.id,
  };

  // No crítico — nunca debe bloquear el procesamiento real del correo.
  registrarPersonaDesdeCorreo(correo.de, "correo_entrante").catch((error) =>
    console.error("[revisarCorreoNuevo] Error registrando remitente en el directorio de personas:", error)
  );

  // Hallazgo real (2026-09-09): antes, el cuerpo completo solo se leía en el camino SIN adjuntos (más
  // abajo) — un correo CON adjuntos nunca se leía de verdad, solo el `extracto` corto (snippet de
  // Gmail) que se le pasaba a procesarDocumentoLocal. Se hoistea acá arriba porque ahora hace falta en
  // AMBOS caminos: un correo con adjuntos también puede traer una instrucción real en el cuerpo (ver
  // más abajo) que hay que leer, no solo mirar el snippet.
  let cuerpoCompleto: string;
  try {
    cuerpoCompleto = await obtenerCuerpoCompletoCorreo(correo.id);
  } catch (error) {
    // El cuerpo completo es obligatorio. Continuar con una cadena vacía
    // permitiría clasificar, proponer y finalmente marcar READ un correo que
    // nunca se leyó de verdad. El wrapper de la cola convierte este fallo en
    // una acción durable de reintento y conserva el mensaje UNREAD.
    console.error(`[revisarCorreoNuevo] No se pudo leer el cuerpo completo de ${correo.id}:`, error);
    throw error;
  }

  // Pedido explícito de Carlos: analizar el direccionamiento de CADA
  // correo (qué acción hay que tomar, y si el camino está claro,
  // proponerlo directo; si no, preguntar) — nunca dejar caer un correo
  // con adjunto real sin acción. Si trae adjuntos reales, SIEMPRE se
  // procesan con el mismo clasificador robusto de documentos
  // (procesarDocumentoLocal — el mismo que usa Telegram), que YA decide
  // el camino (Drive, Holded como gasto, o ambigüedad a preguntar) sin
  // depender de que el clasificador liviano de correo haya acertado el
  // tipo. Cada adjunto es su propia decisión independiente — un correo
  // con 3 adjuntos necesita 3 resoluciones antes de darse por leído.
  if (correo.adjuntos.length > 0) {
    // Segundo hallazgo real (2026-09-09, caso Alberto/AEAT): un correo con adjuntos iba DIRECTO al
    // procesamiento de documento/gasto de arriba, sin que nada mirara el CUERPO del correo — "Revisa
    // las comunicaciones, interprétala y pasa informe" (una instrucción real y explícita) se ignoró
    // por completo porque el sistema solo vio 2 PDFs que parecían facturas y mandó directo la
    // propuesta de "Crear gasto en Holded". Pedido explícito de Carlos: "debes fortalecer el agente
    // que lee y procesa mails para que de manera muy inteligente identifique qué tipo de mail es y si
    // tiene alguna solicitud que debe procesar" — un documento real y una solicitud real sobre ese
    // documento no son mutuamente excluyentes, así que esto se atiende ANTES de procesar los adjuntos
    // como posible gasto, nunca en su lugar (el loop de abajo sigue corriendo igual, sin cambios).
    // La solicitud del cuerpo es una decisión REAL y separada de cada adjunto. Antes se guardaba con
    // el marcador de cola desactivado, por lo que podía quedar sin resolver y aun así el último adjunto llevaba el
    // contador a cero y marcaba Gmail como leído. Ahora incrementa el contador del activo verificando
    // thread+message exactos y conserva esa misma identidad en la propuesta. Así el correo solo queda
    // leído cuando se resolvieron tanto los adjuntos como lo que pidió el remitente.
    // Pedido explícito de Carlos, tras un caso real (Footprint, Modelo 303/349 de IVA, 2026-09-17):
    // cuando un correo trae varios adjuntos, cada uno mandaba su propia propuesta SIN decir de qué
    // correo venía ni de qué trataba — "no sé de qué se trata el contexto completo del mail al que
    // corresponden esos archivos". Se reutiliza el resumen que analizarCorreo ya calculó arriba (sin
    // costo extra) para dar contexto real en CADA mensaje de adjunto, no solo un contador "N de M".
    let resumenCorreoParaAdjuntos: string | undefined;
    try {
      const analisisConAdjuntos = await analizarCorreo(correo, cuerpoCompleto, true);
      resumenCorreoParaAdjuntos = analisisConAdjuntos.resumen;
      if (!opciones.omitirSolicitudCuerpo &&
          (analisisConAdjuntos.tipo === "necesita_respuesta" || analisisConAdjuntos.tipo === "instruccion_jefe")) {
        let contadorReservado = false;
        let propuestaSolicitud: Awaited<ReturnType<typeof crearPropuestaAccionCorreo>> | undefined;
        if (deColaCorreo) {
          const incrementado = await incrementarPendientesActivo(chatId, identidadCola);
          if (!incrementado) {
            throw new Error("el correo ya no coincide con el activo; no se publica una solicitud que podría cerrar otro correo");
          }
          contadorReservado = true;
        }
        try {
          propuestaSolicitud = await crearPropuestaAccionCorreo({
            chatId,
            messageId: 0,
            de: correo.de,
            asunto: correo.asunto || "(sin asunto)",
            tipo: analisisConAdjuntos.tipo,
            resumen: analisisConAdjuntos.resumen,
            accionSugerida: analisisConAdjuntos.accionSugerida,
            threadId: correo.threadId,
            messageIdHeader: correo.messageIdHeader,
            mensajeId: correo.id,
            deColaCorreo,
          });
        } catch (error) {
          if (contadorReservado) await revertirIncrementoPendientesActivo(chatId, identidadCola);
          throw error;
        }

        const textoSolicitud = [
          `📧 *${propuestaSolicitud.asunto}* — este correo trae ${correo.adjuntos.length === 1 ? "un adjunto" : "adjuntos"} Y además pide algo:`,
          `De: ${propuestaSolicitud.de}`,
          propuestaSolicitud.resumen,
          `→ ${propuestaSolicitud.accionSugerida}`,
        ].join("\n");

        let messageIdSolicitud: number;
        try {
          messageIdSolicitud = await sendTelegramMessageWithButtons(chatId, textoSolicitud, [
            [
              { text: "✅ Proceder", callback_data: `email_proceder:${propuestaSolicitud.id}` },
              { text: "🧠 Guardar como conocimiento", callback_data: `email_guardar:${propuestaSolicitud.id}` },
            ],
            [
              { text: "❌ Descartar", callback_data: `email_descartar:${propuestaSolicitud.id}` },
              { text: "✏️ Dar instrucciones específicas", callback_data: `email_orientar:${propuestaSolicitud.id}` },
            ],
          ]);
        } catch (error) {
          await consumirPropuestaAccionCorreo(propuestaSolicitud.id).catch(() => undefined);
          if (contadorReservado) await revertirIncrementoPendientesActivo(chatId, identidadCola);
          throw error;
        }

        // La propuesta ya es visible y clicable; un fallo al guardar el id
        // de Telegram no invalida esa decisión ni justifica publicarla otra
        // vez. El callback usa el id de propuesta incluido en sus botones.
        await actualizarMessageIdAccionCorreo(propuestaSolicitud.id, messageIdSolicitud).catch((error) =>
          console.error("[revisarCorreoNuevo] Solicitud adicional publicada, pero no se pudo guardar su messageId:", error)
        );
      }
    } catch (error) {
      console.error(
        `[revisarCorreoNuevo] Error preparando la solicitud adicional del correo ${correo.id}; si ya se contó, permanece pendiente y Gmail no se marcará leído:`,
        error
      );
      // No continuar con los adjuntos: si el análisis o la publicación de
      // la solicitud falló, permitir que los adjuntos agoten el contador
      // podría marcar el mensaje leído dejando la petición del cuerpo sin
      // atender. El wrapper mantiene el activo y avisa para reintentar.
      throw error;
    }

    let indiceAdjunto = 0;
    for (const adjunto of correo.adjuntos) {
      indiceAdjunto += 1;
      // Pedido explícito de Carlos, tras un caso real: un correo con 2
      // adjuntos distintos (mismo expediente de envío marítimo) generó 2
      // propuestas seguidas y pareció que había llegado duplicado — eran
      // documentos reales distintos, cada uno con su propia decisión, pero
      // nada en el mensaje lo aclaraba. El contador "N de M" solo hace
      // falta con más de un adjunto — un correo con uno solo no lo
      // necesita, pero el contexto del correo (de/asunto/resumen) sí va
      // SIEMPRE, para no repetir el caso de Footprint (ver hallazgo arriba).
      const contextoCorreo = [
        `📧 De: ${correo.de} — Asunto: "${correo.asunto || "(sin asunto)"}"`,
        resumenCorreoParaAdjuntos,
      ]
        .filter(Boolean)
        .join("\n");
      const notaAdjunto =
        correo.adjuntos.length > 1
          ? `${contextoCorreo}\n📎 Adjunto ${indiceAdjunto} de ${correo.adjuntos.length} de este correo — cada uno es una decisión independiente, no es que se haya repetido.`
          : contextoCorreo;

      // Hallazgo real de auditoría (caso Avianca/Larrauri, 2026-09-10, causa confirmada 2026-09-14
      // con el caso Eurohotel Gran Via Fira — ver resolverUnoActivo en colaRevisionStore.ts): este
      // mismo correo puede volver a llegar acá reprocesado (el hilo de Gmail no siempre quedaba
      // marcado como leído tras la primera resolución — causa real: la fila de la cola se borraba
      // ANTES de confirmar el marcado en Gmail, así que un fallo transitorio de esa llamada perdía el
      // rastro en silencio, ya corregido) — sin este chequeo, se volvía a leer el adjunto, extraer los
      // datos, y proponer un gasto NUEVO para algo ya creado en Holded, confiando solo en que
      // buscarGastoSimilar lo detectara a tiempo (no siempre confiable — ver su comentario: Holded
      // puede tardar en indexar un documento recién creado). Este chequeo se deja como defensa propia,
      // independiente de Holded: si YA hay un registro directo de que ESTE adjunto en
      // concreto (mensajeIdGmail + attachmentId, no solo el correo) se convirtió en un gasto real, se
      // salta su procesamiento — nunca hace falta releerlo ni proponerlo de nuevo. Se hace POR ADJUNTO,
      // no una sola vez antes del loop, a propósito: un correo con varios adjuntos reales y distintos
      // (ver el caso citado arriba) puede tener UNO ya resuelto y OTRO genuinamente pendiente todavía —
      // un chequeo a nivel de correo entero habría saltado también ese otro, sin resolver, por error.
      // partId (no attachmentId) — ver el comentario de AdjuntoCorreo.partId en gmail/client.ts:
      // attachmentId cambia en cada lectura del correo, partId no.
      const gastoYaCreado = await buscarGastoDesdeCorreo(correo.id, adjunto.partId).catch((error) => {
        console.error(`[revisarCorreoNuevo] Error consultando si el adjunto "${adjunto.filename}" ya generó un gasto (no crítico, sigue igual):`, error);
        return undefined;
      });
      if (gastoYaCreado) {
        const estadoRegistro = await revalidarRegistroRecienteDeCorreo(gastoYaCreado).catch((error) => {
          console.error(`[revisarCorreoNuevo] Error revalidando gasto ${gastoYaCreado.gastoId}:`, error);
          return "no_verificable" as const;
        });
        if (estadoRegistro === "confirmado") {
          await sendTelegramMessage(
            chatId,
            `📄 "${adjunto.filename}" (${correo.asunto}) — ya generó el gasto VERIFICADO ${gastoYaCreado.gastoId} (${gastoYaCreado.empresa}) antes, no propongo uno nuevo.`
          ).catch(() => {});
          if (deColaCorreo) {
            await avanzarColaCorreoSiActivo(
              chatId,
              identidadCola,
              `correo:${correo.id}:adjunto:${adjunto.partId}:resolver`
            );
          }
          continue;
        }
        if (estadoRegistro === "incompleto") {
          await sendTelegramMessage(
            chatId,
            `🔄 El gasto ${gastoYaCreado.gastoId} ya existe, pero quedó incompleto. Voy a reutilizar el flujo ` +
              `uno a uno para verificar/adjuntar este mismo soporte y retomar su conciliación; no se podrá crear otro gasto.`
          ).catch(() => {});
          // Sigue con la descarga y lectura del adjunto. procesarGastoEntrante
          // reconoce el registro incompleto y crea únicamente una propuesta
          // de recuperación para SU mismo purchase id.
        }
        if (estadoRegistro === "no_verificable") {
          await publicarReintentoTecnico(
            chatId,
            correo,
            `adjunto:${adjunto.partId}`,
            `⚠️ No pude confirmar en Holded si el gasto ${gastoYaCreado.gastoId} asociado a "${adjunto.filename}" existe. ` +
              `Por seguridad no lo doy por creado ni genero otro.`
          );
          continue;
        }
        if (estadoRegistro === "fantasma_eliminado") {
          await sendTelegramMessage(
            chatId,
            `⚠️ El registro reciente decía que "${adjunto.filename}" había creado el gasto ${gastoYaCreado.gastoId}, ` +
              `pero Holded devolvió 404. Invalidé solo esa referencia fantasma; ahora vuelvo a descargar y leer este adjunto completo antes de proponer nada.`
          ).catch(() => {});
        }
      }

      // Hallazgo real (caso real Carlos, 2026-09-10 — correo con 8 adjuntos, pidió revisar de nuevo
      // el correo para descargar SOLO la factura que faltaba y el sistema volvió a descargar y
      // clasificar las 8): el chequeo de arriba (buscarGastoDesdeCorreo) solo cubre adjuntos que YA
      // se convirtieron en un gasto real — un adjunto que se clasificó como "documento genérico"
      // (archivado en Drive, nunca fue un gasto) no quedaba registrado en ningún lado, así que
      // CUALQUIER reproceso del mismo correo (automático por cron, o pedido puntual vía
      // revisar_correo_puntual — ambos pasan por este mismo loop) lo volvía a descargar y clasificar
      // desde cero. Mismo criterio granular que el chequeo de arriba: por adjunto, no por correo
      // entero, para no saltarse por error un adjunto real y distinto que sí siga pendiente.
      const yaArchivado = await yaSeArchivoDesdeCorreo(correo.id, adjunto.partId).catch((error) => {
        console.error(`[revisarCorreoNuevo] Error consultando si el adjunto "${adjunto.filename}" ya se archivó (no crítico, sigue igual):`, error);
        return false;
      });
      if (yaArchivado) {
        await sendTelegramMessage(
          chatId,
          `📄 "${adjunto.filename}" (${correo.asunto}) — ya se revisó antes y se archivó como documento (no era un gasto), no lo vuelvo a descargar.`
        ).catch(() => {});
        if (deColaCorreo) {
          await avanzarColaCorreoSiActivo(
            chatId,
            identidadCola,
            `correo:${correo.id}:adjunto:${adjunto.partId}:resolver`
          );
        }
        continue;
      }

      try {
        const bytes = await descargarAdjunto(correo.id, adjunto.attachmentId);
        await mkdir(UPLOADS_DIR, { recursive: true });

        const nombreArchivo = `${Date.now()}_${sanitizarNombre(adjunto.filename)}`;
        const destino = join(UPLOADS_DIR, nombreArchivo);
        await writeFile(destino, bytes);

        const resultadoDocumento = await procesarDocumentoLocal({
          chatId,
          rutaLocal: destino,
          nombreArchivoOriginal: adjunto.filename,
          mimeType: adjunto.mimeType,
          nombreParaClasificar: adjunto.filename,
          // Hallazgo real de auditoría (caso real Carlos, Uber Bogotá/Nicolás Gómez, 34980 COP): esto
          // usaba correo.extracto (el snippet corto de Gmail, msg.snippet, ~100-200 caracteres) — para
          // un "Fwd:" cuyo preámbulo son varias líneas de cabecera ("---------- Forwarded message
          // ---------", From/Date/Subject), el snippet de Gmail puede agotarse ENTERO en ese preámbulo
          // y nunca llegar a la línea real de contenido. Caso real confirmado en vivo: el correo traía
          // "Uber - €9,92 - $$34980 - Aeropuerto Col a Casa..." — el equivalente EUR explícito que
          // extraerDatosFactura ya sabe buscar (ver su system prompt) — pero el snippet cortaba justo
          // antes, en "...Subject: Factura Uber - Aeropuerto COL a Casa - Viaje CentroAmerica", así que
          // ese equivalente NUNCA llegó al modelo: no es que lo pasara por alto, nunca lo vio. Mismo
          // cuerpoCompleto (obtenerCuerpoCompletoCorreo) que este mismo correo ya lee más arriba para
          // decidir si además pide algo — ya en memoria, sin costo adicional.
          captionEfectivo: `Adjunto de correo. De: ${correo.de}. Asunto: ${correo.asunto}. ${cuerpoCompleto || correo.extracto}`,
          // deColaCorreo real del llamador — permite a documentCallbackHandler.ts y
          // gastoCallbackHandler.ts distinguir esta propuesta (que sí debe
          // avanzar la cola de revisión al resolverse) de una propuesta
          // creada por CUALQUIER otro camino no relacionado (una foto
          // subida por Telegram, capturar_correo bajo demanda, un correo
          // puntual fuera de la cola...) — bug real encontrado en auditoría:
          // sin este marcador, resolver CUALQUIER propuesta de gasto/documento
          // en el mismo chat hacía avanzar/marcar-como-leído el correo activo
          // de esta cola, aunque no tuviera ninguna relación real con él.
          correoOrigen: {
            de: correo.de,
            asunto: correo.asunto || "(sin asunto)",
            threadId: correo.threadId,
            messageIdHeader: correo.messageIdHeader,
            deColaCorreo,
            // Causa raíz real, encontrada en vivo: un gasto se creó en
            // Holded SIN su comprobante ("ENOENT: no such file or
            // directory, open '/app/tmp/uploads/...'") — el archivo local
            // no sobrevive un redeploy de Railway, pero la propuesta en
            // Sheets sí, así que un adjunto que queda pendiente durante
            // CUALQUIER redeploy (frecuente en desarrollo activo, y ahora
            // más probable con los TTLs largos de hoy) pierde su copia de
            // trabajo aunque el original siga intacto en Gmail. Guardar el
            // messageId+attachmentId reales permite volver a descargarlo
            // de la fuente durable si la copia local desaparece (ver
            // reDescargarAdjuntoSiFalta.ts).
            mensajeIdGmail: correo.id,
            attachmentIdGmail: adjunto.attachmentId,
            // Estable entre lecturas (a diferencia de attachmentIdGmail) — es lo que se usa para
            // registrar/consultar "¿ya se resolvió este adjunto?" (ver AdjuntoCorreo.partId).
            partId: adjunto.partId,
          },
          notaAdjunto,
        });

        // Bug real encontrado en vivo: cuando procesarDocumentoLocal
        // detecta que ya hay una propuesta de "Crear gasto" pendiente para
        // la misma factura (ver buscarPropuestaGastoPendiente), no manda
        // ninguna propuesta NUEVA con botones — así que nada más iba a
        // resolver este "pendiente" de la cola, dejándolo trabado
        // esperando algo que nunca iba a llegar. Se avanza acá mismo,
        // igual que el resto de los caminos que terminan sin mandar
        // ninguna propuesta real (ver el catch de abajo) — solo si esto
        // sí vino de la cola.
        if (resultadoDocumento === "gasto_duplicado" && deColaCorreo) {
          await avanzarColaCorreoSiActivo(
            chatId,
            identidadCola,
            `correo:${correo.id}:adjunto:${adjunto.partId}:resolver`
          );
        }

        // NO se registra "ya archivado" acá — procesarDocumentoLocal retornando "archivo" solo
        // significa que se MANDÓ una propuesta/pregunta a Telegram, no que el documento ya se
        // archivó de verdad (falta el clic de Carlos, y el archivado real puede fallar). El registro
        // real vive en los puntos de RESOLUCIÓN (documentCallbackHandler.ts / reclasificarDocumentoPendiente.ts
        // — ver yaSeArchivoDesdeCorreo/registrarDocumentoArchivadoDesdeCorreo ahí), mismo criterio ya
        // usado para gastos (registrarGastoDesdeCorreo se llama tras la creación real en Holded, no al
        // proponer).
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[revisarCorreoNuevo] Error procesando adjunto "${adjunto.filename}":`, message);
        // No marcar como leído ni avanzar: el adjunto NO se procesó. La
        // acción persistida evita que el activo quede bloqueado sin botones.
        await publicarReintentoTecnico(
          chatId,
          correo,
          `adjunto:${adjunto.partId}`,
          `⚠️ No pude procesar el adjunto "${adjunto.filename}" de "${correo.asunto}" (${message}).`
        );
      }
    }
    return;
  }

  // Pedido explícito de Carlos, tras un caso real ("no sé darte respuesta
  // porque no sé de qué MAIL me hablas" / "debes leer todos y cada uno de
  // los mails, así podrás preguntar qué hacer con la información...si es
  // para hacer un gasto, si es para guardar la información, si es para
  // dejarlo en tu base de conocimiento, si es para guardar un archivo, si
  // es para mandar un correo, si es para guardar una alerta"): TODO correo
  // sin adjunto pasa por el mismo análisis con el CUERPO COMPLETO (no solo
  // el extracto), y recibe el MISMO tratamiento sin importar su tipo —
  // antes notas_reunion iba directo a "¿qué empresa?" sin decir de qué
  // correo se trataba, e informativo tenía su propia pregunta binaria
  // aparte; ahora es una sola propuesta con resumen real + acción concreta
  // sugerida + 4 opciones, igual que ya funcionaba bien para
  // necesita_respuesta/instruccion_jefe. (cuerpoCompleto ya se leyó arriba, al principio de la
  // función — ahora se necesita en ambos caminos, con o sin adjuntos.)

  // Pedido explícito de Carlos, tras un caso real: un correo sin adjunto
  // puede describir un gasto real igual que uno con adjunto (ej. una
  // notificación de tarjeta pegada como texto/HTML en el cuerpo, sin
  // ningún PDF/imagen real) — "solo te das cuenta si es un gasto cuando no
  // tiene anexo... si lees todos los correos, cuando lo leas identificas,
  // me preguntas". Antes de caer al análisis genérico, se intenta leer el
  // cuerpo como gasto exactamente con el mismo criterio que un adjunto
  // real (mismo patrón que procesarDocumentoLocal.ts: primero factura/
  // gasto, si no lo es cae al camino normal). Si sí es un gasto, se genera
  // un PDF con los datos + el cuerpo completo como comprobante (no hay
  // ningún archivo real que adjuntar) y sigue por el MISMO camino que un
  // adjunto real (procesarGastoEntrante) — reutiliza tal cual el matching
  // de Holded/banco, la moneda equivalente, y la pregunta de conciliar,
  // sin duplicar nada de esa lógica.
  let gastoDetectado: DatosFactura | undefined;
  const reutilizacion = await buscarAnalisisAutomaticoReciente(correo.id)
    .then(reutilizarGastoDeAnalisisAutomatico)
    .catch(error => {
      console.error(`[revisarCorreoNuevo] No se pudo reutilizar el análisis automático de ${correo.id}:`, error);
      return { concluyente: false } as const;
    });
  if (reutilizacion.concluyente) {
    gastoDetectado = reutilizacion.gasto;
  } else {
    try {
      gastoDetectado = await extraerGastoDeCorreo(cuerpoCompleto, {
        de: correo.de,
        asunto: correo.asunto,
        fecha: correo.fecha,
      });
    } catch (error) {
      // Un fallo del extractor no demuestra que el correo no sea un gasto.
      // Caer al clasificador genérico ocultaba el fallo y podía cerrar el
      // correo sin haber despejado la ruta contable. Se reintenta de forma
      // durable y el mensaje permanece UNREAD.
      console.error(`[revisarCorreoNuevo] No se pudo determinar si ${correo.id} contiene un gasto:`, error);
      throw error;
    }
  }

  if (gastoDetectado?.esFacturaOGasto) {
    // Mismo chequeo que el camino con adjuntos, arriba — ver su comentario (caso Avianca/Larrauri).
    const gastoYaCreadoEnCuerpo = await buscarGastoDesdeCorreo(correo.id).catch((error) => {
      console.error(`[revisarCorreoNuevo] Error consultando si el correo ${correo.id} ya generó un gasto (no crítico, sigue igual):`, error);
      return undefined;
    });
    if (gastoYaCreadoEnCuerpo) {
      const estadoRegistro = await revalidarRegistroRecienteDeCorreo(gastoYaCreadoEnCuerpo).catch((error) => {
        console.error(`[revisarCorreoNuevo] Error revalidando gasto ${gastoYaCreadoEnCuerpo.gastoId}:`, error);
        return "no_verificable" as const;
      });
      if (estadoRegistro === "confirmado") {
        await sendTelegramMessage(
          chatId,
          `📄 "${correo.asunto}" — ya generó el gasto VERIFICADO ${gastoYaCreadoEnCuerpo.gastoId} (${gastoYaCreadoEnCuerpo.empresa}) antes, no propongo uno nuevo.`
        ).catch(() => {});
        if (deColaCorreo) {
          await avanzarColaCorreoSiActivo(chatId, identidadCola, `correo:${correo.id}:cuerpo:resolver`);
        }
        return;
      }
      if (estadoRegistro === "incompleto") {
        await sendTelegramMessage(
          chatId,
          `🔄 El gasto ${gastoYaCreadoEnCuerpo.gastoId} ya existe, pero quedó incompleto. Voy a reconstruir fielmente ` +
            `el soporte desde este correo y retomar ese mismo gasto; no se podrá crear otro.`
        ).catch(() => {});
        // Sigue hasta procesarGastoEntrante, que convierte el registro
        // incompleto en una propuesta de recuperación del mismo purchase id.
      }
      if (estadoRegistro === "no_verificable") {
        await publicarReintentoTecnico(
          chatId,
          correo,
          "cuerpo",
          `⚠️ No pude confirmar en Holded si el gasto ${gastoYaCreadoEnCuerpo.gastoId} asociado a este correo existe. ` +
            `Por seguridad no lo doy por creado ni genero otro.`
        );
        return;
      }
      if (estadoRegistro === "fantasma_eliminado") {
        await sendTelegramMessage(
          chatId,
          `⚠️ El registro reciente de este correo apuntaba al gasto ${gastoYaCreadoEnCuerpo.gastoId}, pero Holded devolvió 404. ` +
            `Invalidé solo esa referencia fantasma y vuelvo a leer el cuerpo completo antes de proponer nada.`
        ).catch(() => {});
      }
    }

    try {
      // No ocultar errores de Gmail: si el correo sí tenía diseño y no se
      // logra recuperarlo, un PDF de texto no es un comprobante fiel.
      const htmlOriginal = await obtenerHtmlVisualCorreo(correo.id);
      const bytes = await generarComprobantePDF(
        { de: correo.de, asunto: correo.asunto, fecha: correo.fecha, cuerpoCompleto, htmlOriginal },
        gastoDetectado
      );
      await mkdir(UPLOADS_DIR, { recursive: true });
      const nombreArchivo = `${Date.now()}_comprobante_${sanitizarNombre(correo.asunto || "correo")}.pdf`;
      const destino = join(UPLOADS_DIR, nombreArchivo);
      await writeFile(destino, bytes);

      // Nota honesta en el concepto: se conserva visualmente el correo, pero
      // el remitente no incluyó un archivo adjunto independiente.
      const datosConNota: DatosFactura = {
        ...gastoDetectado,
        concepto: gastoDetectado.concepto
          ? `${gastoDetectado.concepto} (comprobante visual generado desde el cuerpo del correo, sin adjunto original)`
          : "Gasto detectado en el cuerpo del correo (comprobante visual, sin adjunto original)",
      };

      const resultadoGasto = await procesarGastoEntrante({
        chatId,
        rutaLocal: destino,
        nombreArchivoOriginal: nombreArchivo,
        mimeType: "application/pdf",
        datos: datosConNota,
        deColaCorreo,
        correoOrigen: {
          de: correo.de,
          asunto: correo.asunto || "(sin asunto)",
          threadId: correo.threadId,
          messageIdHeader: correo.messageIdHeader,
          mensajeIdGmail: correo.id,
        },
      });
      if (resultadoGasto === "propuesta_duplicada" && deColaCorreo) {
        await avanzarColaCorreoSiActivo(chatId, identidadCola, `correo:${correo.id}:cuerpo:resolver`);
      }
      return;
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      console.error(`[revisarCorreoNuevo] Error generando la propuesta de gasto desde el cuerpo del correo ${correo.id}:`, error);
      await publicarReintentoTecnico(
        chatId,
        correo,
        "cuerpo",
        `⚠️ Detecté un gasto en "${correo.asunto}", pero no pude conservar fielmente el diseño de su comprobante ` +
          `(${detalle}). No creé ni adjunté una reconstrucción deformada.`
      );
      // No convertirlo en una propuesta genérica ni avanzar la cola: ambas
      // cosas ocultarían que el soporte contable aún no está resuelto.
      return;
    }
  }

  const analisis = await analizarCorreo(correo, cuerpoCompleto);

  const propuesta = await crearPropuestaAccionCorreo({
    chatId,
    messageId: 0,
    de: correo.de,
    asunto: correo.asunto || "(sin asunto)",
    tipo: analisis.tipo,
    resumen: analisis.resumen,
    accionSugerida: analisis.accionSugerida,
    threadId: correo.threadId,
    messageIdHeader: correo.messageIdHeader,
    mensajeId: correo.id,
    deColaCorreo,
  });

  const texto = [`📧 *${propuesta.asunto}*`, `De: ${propuesta.de}`, propuesta.resumen, `→ ${propuesta.accionSugerida}`].join(
    "\n"
  );

  let messageId: number;
  try {
    messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "✅ Proceder", callback_data: `email_proceder:${propuesta.id}` },
        { text: "🧠 Guardar como conocimiento", callback_data: `email_guardar:${propuesta.id}` },
      ],
      [
        { text: "❌ Descartar", callback_data: `email_descartar:${propuesta.id}` },
        { text: "✏️ Dar instrucciones específicas", callback_data: `email_orientar:${propuesta.id}` },
      ],
    ]);
  } catch (error) {
    await consumirPropuestaAccionCorreo(propuesta.id).catch(() => undefined);
    throw error;
  }

  await actualizarMessageIdAccionCorreo(propuesta.id, messageId).catch((error) =>
    console.error("[revisarCorreoNuevo] Propuesta publicada; no se pudo guardar su messageId:", error)
  );
}

/**
 * Procesa el correo que acaba de pasar a "activo" en la cola (el más
 * antiguo pendiente) — fija cuántas decisiones hacen falta para darlo por
 * resuelto (ver establecerPendientesActivo) y delega el análisis real en
 * procesarCorreoLocalizado (deColaCorreo=true). Si algo se rompe, el correo
 * permanece activo y sin leer hasta un reintento o descarte explícito.
 */
export async function procesarSiguienteCorreoActivo(chatId: number): Promise<void> {
  return conCoordinadorCorreo(() => procesarSiguienteCorreoActivoInterno(chatId));
}
/**
 * Variante para llamadores que YA poseen conCoordinadorCorreo durante toda
 * su transacción (watchdog). No usar fuera de ese contexto.
 */
export async function procesarSiguienteCorreoActivoYaCoordinado(chatId: number): Promise<void> {
  return procesarSiguienteCorreoActivoInterno(chatId);
}
async function procesarSiguienteCorreoActivoInterno(chatId: number): Promise<void> {
  const activo = await iniciarSiguienteActivo(chatId);
  if (!activo) return; // cola vacía — nada más que revisar.

  try {
    const correo = await obtenerResumenCorreo(activo.mensajeId);
    if (correo.id !== activo.mensajeId || correo.threadId !== activo.id) {
      throw new Error("Gmail devolvió una identidad distinta a la fila activa; se conserva sin leer");
    }
    await comprobarCorreoDisponible(correo.threadId);
    const identidadActiva = { threadId: activo.id, mensajeId: activo.mensajeId };
    const inicializado = await establecerPendientesActivo(
      chatId,
      identidadActiva,
      correo.adjuntos.length > 0 ? correo.adjuntos.length : 1
    );
    if (!inicializado) {
      throw new Error("el correo cambió antes de inicializar sus decisiones pendientes");
    }
    await procesarCorreoLocalizado(chatId, correo, true);
  } catch (error) {
    console.error(`[revisarCorreoNuevo] Error procesando correo activo ${activo.id}:`, error);
    const detalle = error instanceof Error ? error.message : String(error);
    await publicarReintentoTecnico(
      chatId,
      {
        de: activo.de,
        asunto: activo.asunto,
        threadId: activo.id,
        messageIdHeader: "",
        id: activo.mensajeId,
      },
      "correo",
      `⚠️ Hubo un error revisando "${activo.asunto}" (${detalle}); no avancé la cola.`
    ).catch(async (errorPublicando) => {
      console.error("[revisarCorreoNuevo] Tampoco se pudo publicar la acción durable de reintento:", errorPublicando);
      await sendTelegramMessage(
        chatId,
        `⚠️ Hubo un error revisando "${activo.asunto}" y no pude publicar sus botones. ` +
          `El correo sigue sin leer y activo; el autodiagnóstico lo reintentará sin perderlo ni bloquear la bandeja.`
      ).catch(() => {});
    });
  }
}

/**
 * Reintenta únicamente la unidad que falló. La propuesta se reclama de forma
 * atómica en emailActionStore y el coordinador serializa todo el buzón. Así un
 * doble toque no vuelve a descargar/crear dos veces ni puede cerrar el correo
 * que haya quedado activo después.
 */
export async function handleReintentarActivoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  const telegramMessageId = callback.message?.message_id;
  const id = callback.data?.split(":")[1];

  await answerCallbackQuery(callback.id, "Reintentando...").catch((error) =>
    console.error("[revisarCorreoNuevo] No se pudo responder el callback de reintento (no crítico):", error)
  );
  if (chatId === undefined || !id) return;

  if (telegramMessageId !== undefined) {
    await editTelegramMessageReplyMarkup(chatId, telegramMessageId, []).catch((error) =>
      console.error("[revisarCorreoNuevo] No se pudo desactivar el botón de reintento (no crítico):", error)
    );
  }

  await conCoordinadorCorreo(async () => {
    const propuesta = await consumirPropuestaAccionCorreo(id);
    if (!propuesta) {
      await sendTelegramMessage(chatId, "Esta acción ya fue procesada o reemplazada por una más reciente.").catch(() => {});
      return;
    }

    const alcance = alcanceReintentoDePropuesta(propuesta);
    const activo = await obtenerActivoActual(chatId);
    const identidadCoincide = Boolean(
      alcance &&
      propuesta.deColaCorreo &&
      activo &&
      activo.id === propuesta.threadId &&
      activo.mensajeId === propuesta.mensajeId
    );
    if (!alcance || !identidadCoincide || !activo) {
      await sendTelegramMessage(
        chatId,
        "Esta acción pertenece a un correo que ya no es el activo. No ejecuté nada ni afecté la cola actual."
      ).catch(() => {});
      return;
    }

    try {
      const correo = await obtenerResumenCorreo(propuesta.mensajeId);
      if (correo.id !== propuesta.mensajeId || correo.threadId !== propuesta.threadId) {
        throw new Error("Gmail devolvió una identidad distinta; no se ejecutó el reintento");
      }
      await comprobarCorreoDisponible(correo.threadId);

      if (alcance === "correo") {
        if (activo.pendientesRestantes < 1) {
          const inicializado = await establecerPendientesActivo(
            chatId,
            { threadId: activo.id, mensajeId: activo.mensajeId },
            correo.adjuntos.length > 0 ? correo.adjuntos.length : 1
          );
          if (!inicializado) throw new Error("el correo dejó de ser el activo antes de reiniciar");
        }
        await procesarCorreoLocalizado(chatId, correo, true);
        return;
      }

      if (alcance === "cuerpo") {
        await procesarCorreoLocalizado(chatId, { ...correo, adjuntos: [] }, true);
        return;
      }

      const partId = alcance.slice("adjunto:".length);
      const adjunto = correo.adjuntos.find((item) => item.partId === partId);
      if (!adjunto) throw new Error(`el adjunto ${partId} ya no está disponible en Gmail`);
      await procesarCorreoLocalizado(
        chatId,
        { ...correo, adjuntos: [adjunto] },
        true,
        { omitirSolicitudCuerpo: true }
      );
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      console.error("[revisarCorreoNuevo] Falló el reintento técnico:", error);
      const restaurada: PropuestaAccionCorreo = {
        ...propuesta,
        messageId: telegramMessageId ?? propuesta.messageId,
      };
      await restaurarPropuestaAccionCorreo(restaurada);
      const nuevoMessageId = await sendTelegramMessageWithButtons(
        chatId,
        `⚠️ El reintento no terminó (${detalle}). El correo sigue sin leer y puedes volver a intentarlo.`,
        botonesReintentoTecnico(restaurada.id, alcance)
      ).catch(() => undefined);
      if (nuevoMessageId !== undefined) {
        await actualizarMessageIdAccionCorreo(restaurada.id, nuevoMessageId).catch(() => undefined);
      }
    }
  });
}

/**
 * Pedido explícito de Carlos: poder decirle "vamos al correo de X, léelo"
 * (urgente, fuera de orden) sin pasar por la cola de más antiguo a más
 * nuevo ni confundirla — busca en Gmail el correo más reciente que
 * coincida con `busqueda` (remitente/asunto/tema, lenguaje natural o
 * consulta real de Gmail) y lo procesa con la MISMA lógica que un correo de
 * la cola (procesarCorreoLocalizado), pero con deColaCorreo=false: nunca
 * toca colaRevisionStore, así que si hay un correo activo de la cola en
 * curso al mismo tiempo, sigue exactamente donde estaba cuando esto
 * termine. Nunca cambia el estado leído/no leído por adelantado ni toca la
 * cola. En el caso histórico esperado el correo ya está leído; si la
 * búsqueda puntual encuentra uno todavía no leído, seguirá así y la cola
 * automática conservará el tracking hasta resolverlo por su flujo normal.
 */
export async function procesarCorreoPuntual(
  chatId: number,
  busqueda: string
): Promise<{ encontrado: boolean; de?: string; asunto?: string; yaEsElActivo?: boolean }> {
  return conCoordinadorCorreo(() => procesarCorreoPuntualInterno(chatId, busqueda));
}
async function procesarCorreoPuntualInterno(
  chatId: number,
  busqueda: string
): Promise<{ encontrado: boolean; de?: string; asunto?: string; yaEsElActivo?: boolean }> {
  const query = busqueda.trim() ? `${busqueda.trim()} in:inbox` : "is:unread in:inbox";
  const ids = await buscarMensajes(query, 1);
  if (ids.length === 0) return { encontrado: false };

  const correo = await obtenerResumenCorreo(ids[0]);

  // Hallazgo real de la auditoría: si el correo que se encuentra acá es JUSTO el mismo que ya está
  // "activo" en la cola en este momento, procesarlo también por este camino (deColaCorreo=false)
  // crearía una SEGUNDA propuesta/gasto para el mismo correo, sin que ninguna de las dos se entere
  // de la otra — confuso (dos mensajes con botones para lo mismo) y, en el peor caso, un intento de
  // gasto duplicado. En ese caso exacto, mejor avisar y dejar que se resuelva desde la propuesta que
  // la cola ya mandó, en vez de duplicar el trabajo.
  const activo = await obtenerActivoActual(chatId).catch(() => undefined);
  // Comparar también por THREAD id: una búsqueda puntual puede devolver un
  // mensaje anterior del mismo hilo y no necesariamente el messageId más
  // reciente guardado en la cola. Sigue siendo la misma conversación y no
  // debe producir una segunda propuesta paralela.
  if (activo && (activo.id === correo.threadId || activo.mensajeId === correo.id)) {
    return { encontrado: true, de: correo.de, asunto: correo.asunto, yaEsElActivo: true };
  }

  await comprobarCorreoDisponible(correo.threadId);
  await procesarCorreoLocalizado(chatId, correo, false);
  return { encontrado: true, de: correo.de, asunto: correo.asunto };
}

/**
 * Señal genérica de "algo se resolvió para el correo activo de este chat,
 * si lo hay" — pensada para llamarse desde CUALQUIER punto terminal ya
 * existente del sistema (doc_confirm, doc_reroute, gasto_adjuntar/nuevo/
 * cancelar, email_proceder/descartar, continuarConOrientacion,
 * capturaempresa_confirmar/cancelar, correoinfo_siguiente) sin que ese
 * código necesite saber si en verdad hay una revisión de correo en curso:
 * si no hay ningún correo activo para este chat (el caso normal, la
 * inmensa mayoría de acciones NO vienen de esta cola), esto no hace nada.
 * Cuando el correo activo queda resuelto (pendientesRestantes llega a 0),
 * lo marca como leído en Gmail — y avisa que ya no queda ninguno, o pide
 * confirmación antes de mostrar el siguiente (ver el comentario de
 * handleColaCorreoSiguienteCallback más abajo para el porqué).
 */
export async function avanzarColaCorreoSiActivo(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  claveIdempotencia?: string
): Promise<boolean> {
  // Copia defensiva: el reintento debe conservar exactamente la identidad
  // del clic original, no una referencia mutable de su store.
  let identidadParaReintento: IdentidadCorreoCola = {
    threadId: identidadEsperada.threadId,
    mensajeId: identidadEsperada.mensajeId,
  };
  try {
    const procesado = await conCoordinadorCorreo(() => avanzarColaCorreoSiActivoInterno(
      chatId,
      identidadParaReintento,
      (identidadResuelta) => { identidadParaReintento = identidadResuelta; },
      claveIdempotencia
    ));
    limpiarReintentoAvanceCola(chatId, identidadParaReintento, claveIdempotencia);
    return procesado;
  } catch (error) {
    // La acción que llamó a esta función ya terminó (crear, conciliar, cancelar, archivar, etc.). Un
    // lock_timeout del coordinador o un 429 transitorio de Sheets solo impide confirmar el cierre de
    // la cola; propagarlo hacía que el callback mostrara "no pude confirmar cómo terminó tu selección"
    // aunque el resultado real ya estuviera aplicado. El avance es idempotente cuando llega a cero,
    // así que se reintenta aparte y el resultado contable no se vuelve a ejecutar.
    console.error("[revisarCorreoNuevo] No se pudo cerrar la cola; se reintentará sin repetir la acción:", error);
    programarReintentoAvanceCola(chatId, identidadParaReintento, claveIdempotencia);
    return false;
  }
}

const reintentosAvanceCola = new Map<string, { intentos: number; timer?: ReturnType<typeof setTimeout> }>();
const MAX_REINTENTOS_AVANCE_COLA = 5;

function claveReintentoAvance(
  chatId: number,
  identidad: IdentidadCorreoCola,
  claveIdempotencia?: string
): string {
  return `${chatId}:${identidad.threadId ?? ""}:${identidad.mensajeId ?? ""}:${claveIdempotencia?.trim() ?? ""}`;
}

function limpiarReintentoAvanceCola(
  chatId: number,
  identidad: IdentidadCorreoCola,
  claveIdempotencia?: string
): void {
  const clave = claveReintentoAvance(chatId, identidad, claveIdempotencia);
  const pendiente = reintentosAvanceCola.get(clave);
  if (pendiente?.timer) clearTimeout(pendiente.timer);
  reintentosAvanceCola.delete(clave);
}

function programarReintentoAvanceCola(
  chatId: number,
  identidad: IdentidadCorreoCola,
  claveIdempotencia?: string
): void {
  const identidadInmutable = { threadId: identidad.threadId, mensajeId: identidad.mensajeId };
  const clave = claveReintentoAvance(chatId, identidadInmutable, claveIdempotencia);
  const actual = reintentosAvanceCola.get(clave) ?? { intentos: 0 };
  if (actual.timer || actual.intentos >= MAX_REINTENTOS_AVANCE_COLA) return;
  const intentos = actual.intentos + 1;
  const demoraMs = Math.min(60_000, 5_000 * 2 ** (intentos - 1));
  const timer = setTimeout(() => {
    reintentosAvanceCola.set(clave, { intentos });
    void avanzarColaCorreoSiActivo(chatId, identidadInmutable, claveIdempotencia);
  }, demoraMs);
  timer.unref();
  reintentosAvanceCola.set(clave, { intentos, timer });
}
async function avanzarColaCorreoSiActivoInterno(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  alResolverIdentidad: (identidad: IdentidadCorreoCola) => void,
  claveIdempotencia?: string
): Promise<boolean> {
  // Los fallos transitorios deben llegar al wrapper para que programe el reintento. Antes se
  // convertían en `terminado:false`, indistinguible de un correo con más decisiones pendientes: un
  // 429 de Sheets dejaba el correo activo sin ningún reintento y el vigilante lo reprocesaba entero.
  const resultado = await resolverUnoActivo(chatId, identidadEsperada, claveIdempotencia);

  // Si ya no existe ese activo exacto, la acción no puede afectar al correo
  // siguiente y se considera cerrada para que su store durable pueda limpiar
  // el outbox. Si sí existe, `aplicado`/`yaAplicado` prueban que el contador
  // quedó persistido exactamente una vez.
  if (!resultado.terminado) return true;
  if (resultado.identidadResuelta) alResolverIdentidad(resultado.identidadResuelta);

  if (resultado.gmailIdResuelto && resultado.identidadResuelta) {
    // Hallazgo real de auditoría (caso Eurohotel/Avianca/Larrauri — ver el comentario de
    // resolverUnoActivo en colaRevisionStore.ts): antes esto era fire-and-forget (sin await, .catch
    // solo logueaba) y la fila de la cola ya se había borrado ANTES de llegar acá — un fallo real
    // (confirmado en logs de producción: cuota de Sheets/Gmail agotada) se perdía en silencio,
    // dejando el hilo sin leer en Gmail para siempre y repitiendo todo el correo desde cero en la
    // próxima revisión. Ahora se espera el resultado real y solo se confirma (borra la fila) si Gmail
    // de verdad devolvió éxito — si falla, la fila queda "activa" (bloqueando, visible) para que se
    // reintente sola en la próxima revisión (ver reintentarActivoPendienteDeMarcarLeido, al principio
    // de esta función) o se destrabe a mano con los mecanismos ya existentes.
    const activoResuelto = await obtenerActivoActual(chatId);
    if (!activoResuelto ||
        activoResuelto.id !== resultado.identidadResuelta.threadId ||
        activoResuelto.mensajeId !== resultado.identidadResuelta.mensajeId) return true;
    const marcado = await marcarMensajeComoLeido(resultado.identidadResuelta.mensajeId).catch((error: unknown) => {
      console.error("[revisarCorreoNuevo] Error marcando el mensaje como leído:", error);
      return false;
    });

    if (!marcado) {
      await sendTelegramMessage(
        chatId,
        "⚠️ Ya resolví este correo pero no pude marcarlo como leído en Gmail (fallo real del lado de Gmail/Sheets) " +
          "— lo dejo activo para no perder el rastro; se reintenta solo en la próxima revisión."
      ).catch(() => {});
      return true;
    }

    const confirmado = await confirmarActivoResueltoTrasMarcarLeido(chatId, resultado.identidadResuelta);
    if (!confirmado) return true;
  }

  if (resultado.gmailIdResuelto) {
    const siguiente = await obtenerPrimerMensajeNoLeidoDeHilo(resultado.gmailIdResuelto);
    if (siguiente) await encolarCorreos(chatId, [{ id: resultado.gmailIdResuelto, mensajeId: siguiente.messageId,
      de: siguiente.de, asunto: siguiente.asunto, fechaOrden: siguiente.recibidoEn }], { reconciliarAusentes: false });
  }

  const quedan = await contarPendientesTotal(chatId);
  if (quedan === 0) {
    await sendTelegramMessage(chatId, "✅ Ya no quedan correos sin leer por resolver — al día.").catch(() => {});
    return true;
  }

  // Pedido explícito de Carlos, tras un caso real: antes esto pasaba
  // directo al siguiente correo apenas se resolvía el anterior — pero él
  // usa el MISMO chat para hacer otras preguntas/averiguaciones al mismo
  // tiempo, y el siguiente correo aparecía de golpe en medio de esas
  // consultas, cruzándose con ellas. Ahora se pide confirmación explícita
  // en vez de avanzar solo (ver pedirConfirmacionSiguienteCorreo) — si no
  // la da, la cola se queda tal cual (nada "activo") hasta que la apruebe,
  // use /revisarcorreo, o llegue la siguiente revisión horaria automática
  // (que vuelve a preguntar, nunca muestra el correo directo — mismo
  // criterio acá que ahí).
  await pedirConfirmacionSiguienteCorreo(
    chatId,
    `✅ Resuelto. Quedan ${quedan} correo${quedan === 1 ? "" : "s"} más en la cola — ¿seguimos con el siguiente?`
  );
  return true;
}

/**
 * Maneja el botón "▶️ Sí, siguiente" (ver el aviso al final de
 * avanzarColaCorreoSiActivo) — recién ahí se muestra de verdad el próximo
 * correo de la cola, nunca antes.
 */
export async function handleColaCorreoSiguienteCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  try {
    await answerCallbackQuery(callback.id);
  } catch (error) {
    console.error("[revisarCorreoNuevo] No se pudo responder el callback_query (no crítico):", error);
  }

  if (chatId === undefined) return;

  // Pedido explícito de Carlos (mismo criterio que "▶️ Aprobar selección" en
  // gastoCallbackHandler.ts): el botón queda inactivo de inmediato — se le
  // quita el teclado a ESTE mensaje (nunca toca su texto) ANTES de procesar
  // el siguiente correo, que puede tardar unos segundos (leer Gmail +
  // clasificar) — así un segundo toque impaciente ya no tiene ningún botón
  // que presionar, en vez de arriesgar mostrar el mismo correo dos veces.
  if (messageId !== undefined) {
    await editTelegramMessageReplyMarkup(chatId, messageId, []).catch((error) =>
      console.error("[revisarCorreoNuevo] Error quitando el teclado antes de procesar (no crítico):", error)
    );
  }
  await sendTelegramMessage(chatId, "🔄 Revisando el siguiente correo...").catch(() => {});

  await procesarSiguienteCorreoActivo(chatId);
}

/**
 * Maneja el botón "🗑️ Descartar y liberar" — pedido explícito de Carlos,
 * tras un caso real: le avisamos que un correo activo seguía bloqueando el
 * resto de la cola, pero él ya lo había resuelto por su cuenta (fuera del
 * chat) — sin este botón, la única forma de destrabarlo era esperar 48h
 * (ver obtenerActivoEstancado/UMBRAL_ACTIVO_ESTANCADO_MS) o encontrar el
 * mensaje original y usar sus botones. Reutiliza el mismo mecanismo que ya
 * usa el auto-salto de 48h (descartarActivoEstancado) — no marca nada como
 * leído en Gmail (Carlos puede haberlo resuelto sin marcarlo), solo deja de
 * bloquear la cola.
 */
/**
 * Descarta el correo ACTIVO de la cola (el que está bloqueando la revisión) y libera la cola para
 * seguir con el siguiente — cuerpo compartido entre el botón "🗑️ Descartar y liberar" y
 * saltarCorreoActivoTool (core/tools/saltarCorreoActivo.ts). Pedido explícito de Carlos: "asegúrate
 * de que cuando algo se bloquee pueda continuar con la revisión de correos sin tener que venir a
 * esta instancia" — antes esto SOLO era alcanzable tocando un botón específico (el de la pregunta
 * "¿conciliar?" estancada, o esperando 48h); ahora también se puede pedir en texto libre en
 * cualquier momento ("sáltate este correo", "este está atascado, sigue con el siguiente").
 * Devuelve un texto describiendo lo que pasó, para que el llamador lo relaye (tool) o lo mande
 * directo (callback).
 */
export async function saltarCorreoActivo(chatId: number): Promise<string> {
  return conCoordinadorCorreo(() => saltarCorreoActivoInterno(chatId));
}
async function saltarCorreoActivoInterno(chatId: number): Promise<string> {
  const activo = await obtenerActivoActual(chatId);
  if (!activo) {
    return "Ya no hay ningún correo activo esperando — nada que saltar.";
  }

  const identidadExacta = { threadId: activo.id, mensajeId: activo.mensajeId };
  const cierre = await prepararCierreExplicitoActivo(
    chatId,
    identidadExacta,
    `saltar:${activo.id}:${activo.mensajeId}`
  );
  if (!cierre.terminado || !cierre.identidadResuelta) {
    return "No pude verificar la identidad exacta de este correo. Lo dejé activo y sin leer para no afectar otro mensaje.";
  }

  const marcado = await marcarMensajeComoLeido(activo.mensajeId);
  if (!marcado) return "No pude marcar el correo como leído. Sigue activo para reintentar sin perderlo de la cola.";
  const borrado = await confirmarActivoResueltoTrasMarcarLeido(chatId, cierre.identidadResuelta);
  if (!borrado) {
    return "Marqué el mensaje exacto como leído, pero no pude confirmar todavía el cierre local. " +
      "Lo mantengo bloqueado e idempotente para que el próximo autodiagnóstico termine el cierre sin repetir el trabajo.";
  }

  // Bug real encontrado en vivo (2026-09-03): esto NO marcaba el hilo como
  // leído en Gmail — que es SIEMPRE la única fuente de verdad de qué falta
  // revisar (is:unread real, ver revisarCorreoNuevo) — así que el hilo
  // "descartado" seguía contando como sin leer ahí, y la siguiente revisión
  // horaria lo volvía a encolar solo, deshaciendo el descarte sin avisar
  // (Carlos lo notó: la cola decía "quedan 7" pero Gmail seguía mostrando
  // 8 sin leer). A diferencia del salto automático por 48h estancado (donde
  // sí tiene sentido no marcarlo, por si de verdad hace falta revisarlo),
  // acá es una decisión EXPLÍCITA del usuario ("esto ya lo gestioné") — se
  // registra primero de forma durable y después se marca leído para que de
  // verdad quede resuelto, no solo oculto un rato.
  const siguiente = await obtenerPrimerMensajeNoLeidoDeHilo(activo.id);
  if (siguiente) await encolarCorreos(chatId, [{ id: activo.id, mensajeId: siguiente.messageId,
    de: siguiente.de, asunto: siguiente.asunto, fechaOrden: siguiente.recibidoEn }], { reconciliarAusentes: false });

  const notaDescartado = `🗑️ Descartado — "${activo.asunto}" (de ${activo.de}). ` +
    "Marcado como leído en Gmail — si en realidad todavía hace falta algo, revísalo a mano.";

  const quedan = await contarPendientesTotal(chatId);
  if (quedan > 0) {
    await pedirConfirmacionSiguienteCorreo(
      chatId,
      `Quedan ${quedan} correo${quedan === 1 ? "" : "s"} más en la cola — ¿seguimos con el siguiente?`
    );
  }

  return notaDescartado;
}

export async function handleDescartarActivoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;

  try {
    await answerCallbackQuery(callback.id);
  } catch (error) {
    console.error("[revisarCorreoNuevo] No se pudo responder el callback_query (no crítico):", error);
  }

  if (chatId === undefined) return;

  const resultado = await saltarCorreoActivo(chatId);
  await sendTelegramMessage(chatId, resultado).catch(() => {});
}
