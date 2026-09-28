import { revisarCorreoNuevo, RevisionCorreoOcupadaError, type ResultadoRevisarCorreo } from "./revisarCorreoNuevo";
import { progresoRevisionAutomatica } from "../gmail/automatico/runtime";
import {
  cancelarReanudacionPendiente,
  decidirReanudacion,
  MAX_REANUDACIONES_ENCADENADAS,
  reclamarReanudacionesPendientes,
  registrarReanudacionPendiente,
  type ReanudacionRevisionCorreo,
} from "../gmail/automatico/reanudacion";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { cierreSolicitado } from "../utils/cierreServicio";
import { obtenerActivoActual } from "../gmail/colaRevisionStore";
import { huboSenalDeEntrega } from "../gmail/senalDeEntrega";
import { hayActividadCallbackReciente } from "../telegram/callbackActivity";

/**
 * La revisión manual de correo (/revisarcorreo) como unidad reanudable.
 *
 * Caso real 2026-09-28 16:12: Carlos lanzó /revisarcorreo y un segundo después Railway mandó
 * SIGTERM (se fusionó otro PR). El servidor esperó 55 s y salió con la revisión en «39/50»: el
 * chat quedó sin cierre («bloqueado» para Carlos), nadie avisó y el proceso nuevo no la retomó.
 * La entrega durable de Telegram no lo cubría porque marca el update «completada» en cuanto el
 * comando se lanza en segundo plano.
 *
 * Este módulo cierra ese hueco con tres piezas que src/server.ts encadena:
 *  - `ejecutarRevisionCorreoManual`: el comando en sí (antes vivía inline en el webhook), que
 *    además recuerda qué chats tienen una revisión manual en curso.
 *  - `avisarYRegistrarRevisionesInterrumpidas`: al recibir SIGTERM, para cada una de esas
 *    revisiones deja una fila durable en Postgres y avisa al chat de inmediato — antes de esperar
 *    a ningún punto de control, para que quede aunque el SIGKILL llegue primero.
 *  - `vigilarReanudacionesPendientes`: el proceso nuevo reclama esas filas y relanza la misma
 *    revisión. No basta con mirar una vez al arrancar: en Railway el contenedor nuevo arranca
 *    ANTES de que el viejo reciba el SIGTERM (y escriba la fila), así que se vigila de forma
 *    periódica. Repetir la revisión es seguro: análisis cacheados por huella y escrituras
 *    durables en Holded.
 */
const dependencias = {
  revisarCorreoNuevo: (chatId: number): Promise<ResultadoRevisarCorreo> => revisarCorreoNuevo({ origen: "manual", chatId }),
  progresoRevisionAutomatica,
  registrarReanudacionPendiente,
  cancelarReanudacionPendiente,
  reclamarReanudacionesPendientes,
  enviar: sendTelegramMessage,
  enviarConBotones: sendTelegramMessageWithButtons,
  cierreSolicitado,
  /**
   * true = el correo activo NO tiene ninguna pregunta viva en el chat (sus botones se perdieron o nunca llegaron).
   * false = sí la tiene, o no se pudo comprobar (nunca se afirma que falta algo sin haberlo comprobado).
   */
  activoSinPreguntaViva: async (chatId: number): Promise<boolean> => {
    const activo = await obtenerActivoActual(chatId);
    if (!activo) return false;
    // pendientesRestantes===0 es un caso distinto (ya resuelto, solo falló confirmar leído en Gmail — la propia
    // revisarCorreoNuevo ya lo reintenta arriba, en reintentarActivoPendienteDeMarcarLeido): NUNCA es "reprocesable",
    // ofrecerlo repetiría trabajo financiero ya terminado (mismo criterio que el vigilante, hallazgo real de auditoría).
    if (activo.pendientesRestantes <= 0) return false;
    // Un botón de gasto puede haber consumido su propuesta y seguir escribiendo en Holded sin tomar el candado del
    // buzón (mismo hueco que protege el vigilante): no ofrecer reprocesar mientras esa ventana sigue abierta.
    if (hayActividadCallbackReciente(chatId)) return false;
    return (await huboSenalDeEntrega(chatId, activo.mensajeId, activo.id)) === false;
  },
};

/** Solo para pruebas: sustituye colaboradores reales (Telegram, Postgres, Gmail) y devuelve cómo restaurarlos. */
export function configurarRevisionCorreoManualParaPruebas(parciales: Partial<typeof dependencias>): () => void {
  const originales = { ...dependencias };
  Object.assign(dependencias, parciales);
  revisionesManualesEnCurso.clear();
  registrosEnVuelo.clear();
  return () => { Object.assign(dependencias, originales); revisionesManualesEnCurso.clear(); registrosEnVuelo.clear(); };
}

const revisionesManualesEnCurso = new Map<number, { reanudaciones: number }>();
/**
 * Registro de reanudación que el SIGTERM dejó en vuelo, por chat. Si la revisión termina por sí
 * sola en esa misma ventana, su cancelación debe esperar a que el INSERT aterrice: si no, el
 * DELETE llegaría antes y quedaría una fila huérfana que el proceso nuevo relanzaría sin motivo.
 */
const registrosEnVuelo = new Map<number, Promise<void>>();

export function ejecutarRevisionCorreoManual(chatId: number, opciones: { reanudaciones?: number } = {}): Promise<void> {
  const reanudaciones = opciones.reanudaciones ?? 0;
  // Si otra orden del mismo chat ya está en curso, revisarCorreoNuevo se une a ella; conservamos
  // el contador más alto para que la cadena de reanudaciones no se reinicie por una orden repetida.
  const previa = revisionesManualesEnCurso.get(chatId);
  revisionesManualesEnCurso.set(chatId, { reanudaciones: Math.max(reanudaciones, previa?.reanudaciones ?? 0) });
  return dependencias.revisarCorreoNuevo(chatId)
    .then(async (resultado) => {
      if (resultado.interrumpida) {
        // El aviso y el registro de reanudación ya los hizo el SIGTERM; aquí no se anuncia nada
        // porque «✅ completa» sería falso y «⚠️ error» también.
        return;
      }
      if (dependencias.cierreSolicitado()) {
        // Terminó por sí misma después del SIGTERM: que el proceso nuevo no la repita entera.
        await registrosEnVuelo.get(chatId)?.catch(() => undefined);
        await dependencias.cancelarReanudacionPendiente(chatId).catch((error) =>
          console.error("[revisarcorreo] No se pudo cancelar la reanudación ya innecesaria:", error)
        );
      }
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
        const sinPregunta = await dependencias.activoSinPreguntaViva(chatId).catch(() => false);
        if (sinPregunta) {
          // El aviso de siempre decía «resuélvelo (los botones siguen arriba)» aunque ya no hubiera ningún botón
          // vivo (Televic, 2026-09-28): un callejón sin salida salvo descartar. Ahora se dice la verdad y se
          // ofrece reprocesarlo, que es lo mismo que hace el vigilante y no pierde ni duplica nada.
          await dependencias.enviarConBotones(
            chatId,
            `⏸️ El correo activo "${resultado.activoBloqueando.asunto}" (de ${resultado.activoBloqueando.de}) no tiene ninguna ` +
              `pregunta viva en el chat: sus botones se perdieron o nunca llegaron. Puedes volver a procesarlo (no se pierde ni se duplica ` +
              `nada) o descartarlo para que el resto de la cola pueda avanzar.`,
            [
              [{ text: "🔄 Reprocesar este correo", callback_data: "colacorreo_reprocesaractivo" }],
              [{ text: "🗑️ Descartar y liberar", callback_data: "colacorreo_descartaractivo" }],
            ]
          ).catch((error) => console.error("Error enviando confirmación de revisión de correo:", error));
        } else {
          await dependencias.enviarConBotones(
            chatId,
            `⏸️ Ya tienes un correo activo esperando tu respuesta: "${resultado.activoBloqueando.asunto}" (de ${resultado.activoBloqueando.de}) — resuélvelo (los botones de esa pregunta siguen arriba en el chat) para que el resto de la cola pueda avanzar.`,
            [[{ text: "🗑️ Descartar y liberar", callback_data: "colacorreo_descartaractivo" }]]
          ).catch((error) => console.error("Error enviando confirmación de revisión de correo:", error));
        }
      } else {
        await dependencias.enviar(
          chatId,
          `✅ Revisión extraordinaria completa — ${resultado.correosRevisados} correo(s) revisado(s).`
        ).catch((error) => console.error("Error enviando confirmación de revisión de correo:", error));
      }
    })
    .catch(async (error) => {
      console.error("Error en revisión extraordinaria de correo:", error);
      const mensaje = error instanceof RevisionCorreoOcupadaError
        ? "⏳ Ya hay otra revisión de correo trabajando. El proceso sigue protegido; vuelve a intentarlo en unos minutos."
        : "⚠️ Hubo un error revisando el correo.";
      await dependencias.enviar(chatId, mensaje).catch(() => {});
    })
    .finally(() => {
      revisionesManualesEnCurso.delete(chatId);
    });
}

/**
 * Llamado por el manejador de SIGTERM. Rápido (una escritura en Postgres y un mensaje por chat):
 * cabe de sobra en la ventana de drenado y no depende de que la revisión llegue a su punto de
 * control. Si Postgres falla, el aviso lo dice y pide relanzar a mano, en vez de prometer una
 * reanudación que no va a ocurrir.
 */
export async function avisarYRegistrarRevisionesInterrumpidas(ahora = Date.now()): Promise<void> {
  for (const [chatId, estado] of revisionesManualesEnCurso) {
    const progreso = dependencias.progresoRevisionAutomatica(chatId);
    const avance = progreso ? ` Último avance: ${progreso.replace(/^⏳\s*/, "")}` : "";
    const registro: ReanudacionRevisionCorreo = { chatId, interrumpidaEn: ahora, reanudaciones: estado.reanudaciones, progreso };
    let programada = true;
    const escritura = dependencias.registrarReanudacionPendiente(registro);
    registrosEnVuelo.set(chatId, escritura);
    try {
      await escritura;
    } catch (error) {
      programada = false;
      console.error("[revisarcorreo] No se pudo registrar la reanudación tras SIGTERM:", error);
    }
    await dependencias.enviar(
      chatId,
      programada
        ? `⏸️ El servicio se reinicia por un despliegue nuevo y la revisión de correo se interrumpe.${avance} Lo ya analizado queda guardado; la retomo automáticamente en cuanto arranque la versión nueva.`
        : `⏸️ El servicio se reinicia por un despliegue nuevo y la revisión de correo se interrumpe.${avance} Lo ya analizado queda guardado, pero no pude dejar programada la reanudación: envía /revisarcorreo cuando arranque la versión nueva.`
    ).catch((error) => console.error("[revisarcorreo] No se pudo avisar de la interrupción por SIGTERM:", error));
  }
}

/**
 * Reclama y relanza las reanudaciones pendientes. Devuelve cuántas se relanzaron. `seguir` recibe
 * cada revisión relanzada para que el servidor la cuente como trabajo en curso (y un SIGTERM
 * posterior la espere y la vuelva a registrar, igual que a una orden escrita a mano). Un proceso
 * que ya está cerrándose nunca reclama: la fila que acaba de escribir es para el siguiente.
 */
export async function reanudarRevisionesCorreoInterrumpidas(
  opciones: { ahora?: number; seguir?: (revision: Promise<void>) => void } = {}
): Promise<number> {
  if (dependencias.cierreSolicitado()) return 0;
  const ahora = opciones.ahora ?? Date.now();
  const registros = await dependencias.reclamarReanudacionesPendientes();
  let relanzadas = 0;
  for (const registro of registros) {
    const decision = decidirReanudacion(registro, ahora);
    if (decision.accion === "caducada") {
      console.log(`[revisarcorreo] Reanudación caducada para el chat ${registro.chatId}; no se relanza.`);
      continue;
    }
    if (decision.accion === "demasiadas") {
      await dependencias.enviar(
        registro.chatId,
        `⚠️ La revisión de correo se ha interrumpido ${MAX_REANUDACIONES_ENCADENADAS} veces seguidas por despliegues, así que no la relanzo sola. ` +
          "Envía /revisarcorreo cuando no haya despliegues en marcha; lo ya analizado sigue guardado."
      ).catch(() => {});
      continue;
    }
    await dependencias.enviar(
      registro.chatId,
      "▶️ Retomo la revisión de correo que interrumpió el despliegue anterior (reutilizo lo ya analizado)…"
    ).catch(() => {});
    relanzadas++;
    const revision = ejecutarRevisionCorreoManual(registro.chatId, { reanudaciones: registro.reanudaciones + 1 });
    if (opciones.seguir) opciones.seguir(revision); else void revision;
  }
  return relanzadas;
}

/**
 * Vigilancia periódica desde el arranque. Orden real de Railway en un despliegue: arranca el
 * contenedor nuevo → pasa el healthcheck → SOLO ENTONCES el viejo recibe SIGTERM y escribe su
 * fila de reanudación. Una sola consulta al arrancar llegaría siempre antes que la fila. Por eso
 * se consulta cada `intervaloInicialMs` durante la ventana de solapamiento + drenado y después,
 * más despacio, para siempre (una consulta a una tabla casi siempre vacía; cubre reinicios en
 * cadena). Los temporizadores no mantienen vivo el proceso y paran al pedirse el cierre.
 */
export function vigilarReanudacionesPendientes(opciones: {
  seguir?: (revision: Promise<void>) => void;
  intervaloInicialMs?: number;
  ventanaInicialMs?: number;
  intervaloPosteriorMs?: number;
  alRelanzar?: (relanzadas: number) => void;
} = {}): () => void {
  const intervaloInicial = opciones.intervaloInicialMs ?? 15_000;
  const ventanaInicial = opciones.ventanaInicialMs ?? 15 * 60_000;
  const intervaloPosterior = opciones.intervaloPosteriorMs ?? 2 * 60_000;
  const inicio = Date.now();
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  let detenida = false;
  const consultar = async (): Promise<void> => {
    if (detenida || dependencias.cierreSolicitado()) return;
    try {
      const relanzadas = await reanudarRevisionesCorreoInterrumpidas({ seguir: opciones.seguir });
      if (relanzadas > 0) opciones.alRelanzar?.(relanzadas);
    } catch (error) {
      console.error("[revisarcorreo] No se pudo revisar si había revisiones interrumpidas:", error);
    }
    if (detenida || dependencias.cierreSolicitado()) return;
    temporizador = setTimeout(() => { void consultar(); }, Date.now() - inicio < ventanaInicial ? intervaloInicial : intervaloPosterior);
    temporizador.unref();
  };
  void consultar();
  return () => { detenida = true; if (temporizador) clearTimeout(temporizador); };
}
