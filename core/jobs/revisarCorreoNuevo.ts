import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listarHilosNoLeidos,
  obtenerUltimoMensajeDeHilo,
  obtenerResumenCorreo,
  obtenerCuerpoCompletoCorreo,
  descargarAdjunto,
  marcarHiloComoLeido,
  buscarMensajes,
  type CorreoResumen,
} from "../gmail/client";
import { analizarCorreo } from "../gmail/classifyEmail";
import { extraerGastoDeCorreo } from "../gmail/extraerGastoDeCorreo";
import { generarComprobantePDF } from "../gmail/generarComprobantePDF";
import { guardarUltimoCheck } from "../gmail/lastCheckStore";
import { sendTelegramMessage, sendTelegramMessageWithButtons, answerCallbackQuery, editTelegramMessageReplyMarkup } from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { procesarDocumentoLocal } from "../documental/procesarDocumentoLocal";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import type { DatosFactura } from "../documental/extractInvoiceData";
import { crearPropuestaAccionCorreo, actualizarMessageIdAccionCorreo } from "../gmail/emailActionStore";
import { registrarPersonaDesdeCorreo } from "../directorio/directorioPersonasSheet";
import {
  encolarCorreos,
  hayActivo,
  contarPendientesTotal,
  iniciarSiguienteActivo,
  establecerPendientesActivo,
  resolverUnoActivo,
  obtenerActivoEstancado,
  descartarActivoEstancado,
  obtenerActivoActual,
} from "../gmail/colaRevisionStore";

// 48h — mismo criterio que classificationStore.ts (48h) y otras propuestas
// "principales" del sistema: suficiente margen para un día de trabajo largo
// o una respuesta demorada, sin dejar la cola trabada indefinidamente.
const UMBRAL_ACTIVO_ESTANCADO_MS = 48 * 60 * 60 * 1000;

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

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
  await sendTelegramMessageWithButtons(chatId, mensaje, [
    [{ text: "▶️ Sí, siguiente", callback_data: "colacorreo_siguiente" }],
  ]);
}

export async function revisarCorreoNuevo(): Promise<ResultadoRevisarCorreo> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  if (!chatId) {
    console.error("[revisarCorreoNuevo] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { correosRevisados: 0 };
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
    await descartarActivoEstancado(chatId, estancado.id).catch((error) =>
      console.error("[revisarCorreoNuevo] Error descartando correo activo estancado:", error)
    );
    await sendTelegramMessage(
      chatId,
      `⚠️ "${estancado.asunto}" (de ${estancado.de}) llevaba más de 48h abierto sin resolverse — lo salto para no ` +
        `trabar el resto de la cola. Sigue sin marcar como leído en Gmail; revísalo a mano si todavía hace falta.`
    ).catch(() => {});
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
    ids = [];
  }

  console.log(`[revisarCorreoNuevo] ${ids.length} hilo(s) sin leer en la bandeja`);

  // Ya no se usa para filtrar (is:unread real reemplazó la ventana de
  // tiempo) — se guarda solo para que estadoAgregado.ts (panel /cerebro)
  // pueda mostrar "última vez que se revisó el correo" sin quedar
  // congelado en el valor de antes de este cambio.
  guardarUltimoCheck(Math.floor(Date.now() / 1000)).catch((error) =>
    console.error("[revisarCorreoNuevo] Error guardando el último check (no crítico):", error)
  );

  const [habiaActivoAntes, totalAntesDeEncolar] = await Promise.all([hayActivo(chatId), contarPendientesTotal(chatId)]);

  const itemsParaEncolar: Array<{ id: string; mensajeId: string; de: string; asunto: string; fechaOrden: number }> = [];
  for (const threadId of ids) {
    try {
      const ultimo = await obtenerUltimoMensajeDeHilo(threadId);
      if (!ultimo) continue;
      const fechaOrden = Date.parse(ultimo.fecha);
      itemsParaEncolar.push({
        id: threadId,
        mensajeId: ultimo.messageId,
        de: ultimo.de,
        asunto: ultimo.asunto || "(sin asunto)",
        fechaOrden: Number.isFinite(fechaOrden) ? fechaOrden : Date.now(),
      });
    } catch (error) {
      console.error(`[revisarCorreoNuevo] Error leyendo metadatos del hilo ${threadId} (se omite de la cola):`, error);
    }
  }

  const nuevos = itemsParaEncolar.length > 0 ? await encolarCorreos(chatId, itemsParaEncolar) : 0;

  // Bug real encontrado en vivo: esto antes vivía DENTRO del `if (nuevos ===
  // 0) return` de arriba — un "revisarcorreo" manual con la cola ya llena
  // pero SIN nada "activo" (ej. justo después de resetear un correo
  // atascado) no encontraba nada NUEVO que encolar, así que la función
  // terminaba ahí ("0 correos revisados") sin nunca retomar lo que ya
  // estaba esperando. Ahora, sin importar si esta corrida encontró algo
  // nuevo, si no hay nada activo y sí hay algo pendiente (nuevo o de antes),
  // se avisa (con botón — nunca se muestra el siguiente correo directo, ver
  // pedirConfirmacionSiguienteCorreo).
  const totalPendienteTrasEncolar = totalAntesDeEncolar + nuevos;
  if (!habiaActivoAntes && totalPendienteTrasEncolar > 0) {
    // Pedido explícito de Carlos: el aviso trae el conteo de "nuevos" solo
    // al EMPEZAR una revisión desde cero — si ya hay un backlog en curso, el
    // mensaje es más genérico (no repite "nuevo" sobre algo que ya se sabía
    // de una corrida anterior).
    const mensaje =
      nuevos > 0 && totalAntesDeEncolar === 0
        ? `📬 Tienes ${nuevos} correo${nuevos === 1 ? "" : "s"} nuevo${nuevos === 1 ? "" : "s"} sin leer — ¿empezamos por el más antiguo?`
        : `Quedan ${totalPendienteTrasEncolar} correo${totalPendienteTrasEncolar === 1 ? "" : "s"} sin leer por revisar — ¿seguimos?`;
    await pedirConfirmacionSiguienteCorreo(chatId, mensaje);
    return { correosRevisados: nuevos };
  }

  if (habiaActivoAntes) {
    const activo = await obtenerActivoActual(chatId).catch(() => undefined);
    if (activo) {
      return { correosRevisados: nuevos, activoBloqueando: { asunto: activo.asunto, de: activo.de } };
    }
  }

  return { correosRevisados: nuevos };
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
async function procesarCorreoLocalizado(chatId: number, correo: CorreoResumen, deColaCorreo: boolean): Promise<void> {
  // No crítico — nunca debe bloquear el procesamiento real del correo.
  registrarPersonaDesdeCorreo(correo.de, "correo_entrante").catch((error) =>
    console.error("[revisarCorreoNuevo] Error registrando remitente en el directorio de personas:", error)
  );

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
    let indiceAdjunto = 0;
    for (const adjunto of correo.adjuntos) {
      indiceAdjunto += 1;
      // Pedido explícito de Carlos, tras un caso real: un correo con 2
      // adjuntos distintos (mismo expediente de envío marítimo) generó 2
      // propuestas seguidas y pareció que había llegado duplicado — eran
      // documentos reales distintos, cada uno con su propia decisión, pero
      // nada en el mensaje lo aclaraba. Solo se agrega la nota cuando hay
      // más de un adjunto — un correo con uno solo no la necesita.
      const notaAdjunto =
        correo.adjuntos.length > 1
          ? `📎 Adjunto ${indiceAdjunto} de ${correo.adjuntos.length} de este correo — cada uno es una decisión independiente, no es que se haya repetido.`
          : undefined;
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
          captionEfectivo: `Adjunto de correo. De: ${correo.de}. Asunto: ${correo.asunto}. ${correo.extracto}`,
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
          await avanzarColaCorreoSiActivo(chatId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[revisarCorreoNuevo] Error procesando adjunto "${adjunto.filename}":`, message);
        // Este adjunto nunca mandó ninguna propuesta — nada lo va a
        // resolver por su cuenta, así que se resuelve acá mismo (con
        // aviso) para no dejar la cola trabada esperando algo que nunca va a llegar.
        await sendTelegramMessage(
          chatId,
          `⚠️ Hubo un error leyendo el adjunto "${adjunto.filename}" de "${correo.asunto}" — lo salto.`
        ).catch(() => {});
        if (deColaCorreo) await avanzarColaCorreoSiActivo(chatId);
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
  // necesita_respuesta/instruccion_jefe.
  const cuerpoCompleto = await obtenerCuerpoCompletoCorreo(correo.id).catch((error) => {
    console.error(`[revisarCorreoNuevo] Error leyendo el cuerpo completo de ${correo.id} (se analiza con lo que haya):`, error);
    return "";
  });

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
  try {
    gastoDetectado = await extraerGastoDeCorreo(cuerpoCompleto, {
      de: correo.de,
      asunto: correo.asunto,
      fecha: correo.fecha,
    });
  } catch (error) {
    console.error(`[revisarCorreoNuevo] Error intentando leer el correo ${correo.id} como gasto (sigue como correo normal):`, error);
  }

  if (gastoDetectado?.esFacturaOGasto) {
    try {
      const bytes = await generarComprobantePDF(
        { de: correo.de, asunto: correo.asunto, fecha: correo.fecha, cuerpoCompleto },
        gastoDetectado
      );
      await mkdir(UPLOADS_DIR, { recursive: true });
      const nombreArchivo = `${Date.now()}_comprobante_${sanitizarNombre(correo.asunto || "correo")}.pdf`;
      const destino = join(UPLOADS_DIR, nombreArchivo);
      await writeFile(destino, bytes);

      // Nota honesta en el concepto — para que la propuesta que ve Carlos
      // deje claro que el "comprobante" es un PDF generado a partir del
      // cuerpo, no el recibo original, sin tocar procesarGastoEntrante.ts.
      const datosConNota: DatosFactura = {
        ...gastoDetectado,
        concepto: gastoDetectado.concepto
          ? `${gastoDetectado.concepto} (comprobante generado desde el cuerpo del correo, sin adjunto original)`
          : "Gasto detectado en el cuerpo del correo (sin adjunto original)",
      };

      await procesarGastoEntrante({
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
      return;
    } catch (error) {
      console.error(`[revisarCorreoNuevo] Error generando la propuesta de gasto desde el cuerpo del correo ${correo.id} (sigue como correo normal):`, error);
      // Cae al análisis genérico de abajo en vez de perder el correo —
      // mejor preguntar de forma genérica que no decir nada.
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

  const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
    [
      { text: "✅ Proceder", callback_data: `email_proceder:${propuesta.id}` },
      { text: "🧠 Guardar como conocimiento", callback_data: `email_guardar:${propuesta.id}` },
    ],
    [
      { text: "❌ Descartar", callback_data: `email_descartar:${propuesta.id}` },
      { text: "✏️ Dar instrucciones específicas", callback_data: `email_orientar:${propuesta.id}` },
    ],
  ]);

  await actualizarMessageIdAccionCorreo(propuesta.id, messageId);
}

/**
 * Procesa el correo que acaba de pasar a "activo" en la cola (el más
 * antiguo pendiente) — fija cuántas decisiones hacen falta para darlo por
 * resuelto (ver establecerPendientesActivo) y delega el análisis real en
 * procesarCorreoLocalizado (deColaCorreo=true). Si algo se rompe antes de
 * llegar a mandar ninguna propuesta, se resuelve igual (con aviso) para no
 * dejar la cola trabada en un correo roto para siempre.
 */
export async function procesarSiguienteCorreoActivo(chatId: number): Promise<void> {
  const activo = await iniciarSiguienteActivo(chatId);
  if (!activo) return; // cola vacía — nada más que revisar.

  try {
    const correo = await obtenerResumenCorreo(activo.mensajeId);
    await establecerPendientesActivo(chatId, activo.id, correo.adjuntos.length > 0 ? correo.adjuntos.length : 1);
    await procesarCorreoLocalizado(chatId, correo, true);
  } catch (error) {
    console.error(`[revisarCorreoNuevo] Error procesando correo activo ${activo.id}:`, error);
    await sendTelegramMessage(chatId, `⚠️ Hubo un error revisando un correo ("${activo.asunto}") — lo salto y sigo con el siguiente.`).catch(
      () => {}
    );
    await establecerPendientesActivo(chatId, activo.id, 1);
    await avanzarColaCorreoSiActivo(chatId);
  }
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
 * termine. Nunca marca el correo como leído por su cuenta (a diferencia de
 * la cola) — eso ya lo hace, si corresponde, la resolución de la propuesta
 * resultante a través del mecanismo normal.
 */
export async function procesarCorreoPuntual(
  chatId: number,
  busqueda: string
): Promise<{ encontrado: boolean; de?: string; asunto?: string; yaEsElActivo?: boolean }> {
  const query = busqueda.trim() ? `${busqueda.trim()} in:inbox` : "in:inbox";
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
  if (activo && activo.mensajeId === correo.id) {
    return { encontrado: true, de: correo.de, asunto: correo.asunto, yaEsElActivo: true };
  }

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
export async function avanzarColaCorreoSiActivo(chatId: number): Promise<void> {
  const resultado = await resolverUnoActivo(chatId).catch((error) => {
    console.error("[revisarCorreoNuevo] Error avanzando la cola de revisión de correo (no crítico):", error);
    return { terminado: false as const };
  });

  if (!resultado.terminado) return;

  if (resultado.gmailIdResuelto) {
    marcarHiloComoLeido(resultado.gmailIdResuelto).catch((error: unknown) =>
      console.error("[revisarCorreoNuevo] Error marcando el hilo como leído (no crítico):", error)
    );
  }

  const quedan = await contarPendientesTotal(chatId);
  if (quedan === 0) {
    await sendTelegramMessage(chatId, "✅ Ya no quedan correos sin leer por resolver — al día.").catch(() => {});
    return;
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
export async function handleDescartarActivoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;

  try {
    await answerCallbackQuery(callback.id);
  } catch (error) {
    console.error("[revisarCorreoNuevo] No se pudo responder el callback_query (no crítico):", error);
  }

  if (chatId === undefined) return;

  const activo = await obtenerActivoActual(chatId);
  if (!activo) {
    await sendTelegramMessage(chatId, "Ya no hay ningún correo activo esperando — nada que descartar.").catch(() => {});
    return;
  }

  const borrado = await descartarActivoEstancado(chatId, activo.id);

  // Bug real encontrado en vivo (2026-09-03): esto NO marcaba el hilo como
  // leído en Gmail — que es SIEMPRE la única fuente de verdad de qué falta
  // revisar (is:unread real, ver revisarCorreoNuevo) — así que el hilo
  // "descartado" seguía contando como sin leer ahí, y la siguiente revisión
  // horaria lo volvía a encolar solo, deshaciendo el descarte sin avisar
  // (Carlos lo notó: la cola decía "quedan 7" pero Gmail seguía mostrando
  // 8 sin leer). A diferencia del salto automático por 48h estancado (donde
  // sí tiene sentido no marcarlo, por si de verdad hace falta revisarlo),
  // acá es una decisión EXPLÍCITA del usuario ("esto ya lo gestioné") — se
  // marca leído para que de verdad quede resuelto, no solo oculto un rato.
  if (borrado) {
    marcarHiloComoLeido(activo.id).catch((error: unknown) =>
      console.error("[revisarCorreoNuevo] Error marcando el hilo como leído tras descartar (no crítico):", error)
    );
  }

  await sendTelegramMessage(
    chatId,
    borrado
      ? `🗑️ Descartado — "${activo.asunto}" (de ${activo.de}). Marcado como leído en Gmail — si en realidad todavía hace falta algo, revísalo a mano.`
      : "Ya se había resuelto por otro camino justo antes — nada que descartar."
  ).catch(() => {});

  const quedan = await contarPendientesTotal(chatId);
  if (quedan > 0) {
    await pedirConfirmacionSiguienteCorreo(
      chatId,
      `Quedan ${quedan} correo${quedan === 1 ? "" : "s"} más en la cola — ¿seguimos con el siguiente?`
    );
  }
}


