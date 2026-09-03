import { unlink } from "node:fs/promises";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import type { InlineKeyboardButton } from "../telegram/types";
import {
  consumirPropuestaGasto,
  obtenerPropuestaGasto,
  crearPropuestaGasto,
  actualizarMessageIdGasto,
  type PropuestaGasto,
} from "./gastoProposalSheet";
import { guardarPendienteCorreccionGasto, type PendienteCorreccionGasto } from "./pendienteCorreccionGastoStore";
import { registrarClasificacionAprendida } from "./clasificacionAprendidaSheet";
import { registrarAliasProveedor } from "./proveedorAliasSheet";
import {
  guardarResolucionContacto,
  consumirResolucionContacto,
  actualizarMessageIdResolucionContacto,
  type AlternativaContacto,
  type ResolucionContactoPendiente,
} from "./contactoResolucionStore";
import { guardarConciliacionPendiente, consumirConciliacionPendiente } from "./conciliacionPendienteStore";
import {
  buscarContactoHolded,
  buscarContactosParecidos,
  buscarComprasPorMonto,
  crearGastoHolded,
  adjuntarComprobanteHolded,
  buscarMovimientoSimilar,
  buscarMovimientoAproximado,
  reconciliarMovimiento,
  ContactoNoEncontradoError,
  FechaBloqueadaError,
  type HoldedContact,
} from "../holded/write";
import { obtenerRolUsuario } from "../telegram/authorizedUsersSheet";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import type { Empresa } from "../holded/client";
import type { TelegramCallbackQuery } from "../telegram/types";

/**
 * Pedido explícito de Carlos, tras un caso real (MERA AEROPUERTO DE PANAMA
 * SA, Footprint): cuando el proveedor no se encuentra en Holded (ni por
 * nombre parecido, ni por importe) y no hay tiempo/interés de crearlo antes
 * de conciliar, el gasto queda bloqueado indefinidamente esperando que
 * alguien cree el contacto real. Verificado en vivo contra la API real de
 * Holded: /purchases EXIGE contact_id (rechaza con 400 "The contact_id
 * field is required" si se omite) — no existe forma de crear una compra sin
 * NINGÚN contacto. Se creó un contacto placeholder reutilizable por empresa
 * ("PROVEEDOR SIN IDENTIFICAR") el 2026-09-01, con autorización explícita
 * de Carlos, para estos casos — el nombre real del proveedor queda en la
 * descripción del gasto (nunca se pierde), y el contacto se puede corregir
 * a mano en Holded después. A diferencia de un contactoForzado normal,
 * NUNCA se aprende como alias — si se aprendiera, la siguiente factura del
 * mismo proveedor (incluso una vez que el contacto real ya exista) seguiría
 * yendo al placeholder para siempre.
 */
const CONTACTO_SIN_IDENTIFICAR_POR_EMPRESA: Record<Empresa, { id: string; name: string }> = {
  WOBA: { id: "6a96da7947b9d9c436035b7a", name: "PROVEEDOR SIN IDENTIFICAR" },
  EWORKS: { id: "6a96da80d133ca5bab0ec4e8", name: "PROVEEDOR SIN IDENTIFICAR" },
  Footprint: { id: "6a96da888467c6eb35096adc", name: "PROVEEDOR SIN IDENTIFICAR" },
};

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[gastoCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

async function limpiarArchivoLocal(rutaLocal: string): Promise<void> {
  await unlink(rutaLocal).catch(() => {}); // no crítico si ya no existe
}

/** Adjunta el comprobante a un gasto de Holded y borra la copia local temporal (solo si tuvo éxito). */
async function adjuntarYLimpiar(propuesta: PropuestaGasto, purchaseId: string): Promise<void> {
  await adjuntarComprobanteHolded(
    propuesta.empresa,
    purchaseId,
    propuesta.rutaLocal,
    propuesta.nombreArchivoOriginal,
    propuesta.mimeType
  );
  await limpiarArchivoLocal(propuesta.rutaLocal);
}

/**
 * Tras crear/adjuntar un gasto con soporte real, intenta cerrar el círculo
 * conciliando el movimiento bancario correspondiente — solo si hay
 * exactamente un candidato sin conciliar con monto/fecha cercanos (nunca
 * adivina entre varios). Siempre relee el movimiento para confirmar el
 * estado real (ver reconciliarMovimiento) — el texto que devuelve refleja
 * lo que se pudo confirmar, nunca asume éxito. Nunca lanza: un fallo aquí
 * no debe tumbar el flujo principal de creación/adjunto, que ya tuvo éxito.
 */
async function intentarConciliar(
  empresa: Empresa,
  monto: number,
  fecha: string,
  gastoId: string,
  moneda: string = "EUR",
  proveedor?: string
): Promise<string> {
  try {
    const fechaBusqueda = fecha || new Date().toISOString().slice(0, 10);
    const candidatos = await buscarMovimientoSimilar(empresa, { monto, fecha: fechaBusqueda, moneda });

    let candidato: Awaited<ReturnType<typeof buscarMovimientoSimilar>>[number] | undefined;
    let esAproximado = false;

    if (candidatos.length === 1) {
      candidato = candidatos[0];
    } else if (candidatos.length > 1) {
      return `\n\n💳 Hay ${candidatos.length} movimientos bancarios sin conciliar parecidos — revísalo a mano en Holded.`;
    } else if (proveedor) {
      // Mismo fallback que procesarGastoEntrante.ts (ver ese archivo para el
      // caso real que lo motivó): el match exacto puede no encontrar nada
      // cuando el equivalente en EUR de la factura es una estimación.
      const aproximados = await buscarMovimientoAproximado(empresa, { monto, fecha: fechaBusqueda, moneda, proveedor });
      if (aproximados.length === 1) {
        candidato = aproximados[0];
        esAproximado = true;
      } else if (aproximados.length > 1) {
        return (
          `\n\n💳 No encontré un movimiento exacto, pero hay ${aproximados.length} parecidos (nombre reconocible, monto ` +
          `cercano) — revísalo a mano en Holded:\n` +
          aproximados.map((m) => `  • "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} ${m.moneda} (${m.fecha})`).join("\n")
        );
      }
    }

    if (!candidato) return "";

    const resultado = await reconciliarMovimiento(empresa, candidato.accountId, candidato.movementId, candidato.fecha, gastoId);
    const notaAprox = esAproximado ? " — coincidencia APROXIMADA (nombre y monto parecidos, no exactos), confírmalo en Holded" : "";

    if (resultado.ok) {
      return (
        `\n\n💳 Movimiento bancario conciliado y enlazado al gasto (${candidato.descripcion || "sin descripción"}, ` +
        `${candidato.monto.toFixed(2)} ${candidato.moneda}, enlazado por ${resultado.montoEnlazado.toFixed(2)} ${candidato.moneda})${notaAprox}.`
      );
    }
    return (
      `\n\n⚠️ Encontré un movimiento bancario parecido (${candidato.descripcion || "sin descripción"}, ` +
      `${candidato.monto.toFixed(2)} ${candidato.moneda}) pero no pude confirmar que quedó conciliado Y enlazado al gasto ` +
      `(estado: ${resultado.statusFinal}, monto enlazado: ${resultado.montoEnlazado.toFixed(2)} ${candidato.moneda}) — revísalo a mano en Holded.`
    );
  } catch (error) {
    console.error("[gastoCallbackHandler] Error intentando conciliar movimiento bancario:", error);
    return "";
  }
}

/**
 * Manda el mensaje de seguimiento preguntando si conciliar el movimiento
 * bancario — solo se usa cuando NO se confirmó un movimiento coincidente
 * ANTES de crear el gasto (ver procesarGastoEntrante.ts): pedido explícito
 * de Carlos, quiere revisar el gasto recién creado en Holded antes de que
 * se intente conciliar, en vez de que ocurra en silencio. Guarda la
 * pregunta en conciliacionPendienteStore (Sheets, sobrevive un redeploy)
 * hasta que se responda con el botón.
 *
 * Devuelve true si la pregunta quedó guardada y enviada de verdad — el
 * llamador (ver deColaCorreo abajo) la usa para decidir si debe esperar la
 * respuesta antes de avanzar la cola de revisión de correo, o si el aviso
 * falló y hay que avanzar de una vez para no dejar la cola esperando una
 * pregunta que nunca llegó.
 */
async function preguntarSiConciliar(
  chatId: number,
  empresa: Empresa,
  monto: number,
  fecha: string,
  descripcionGasto: string,
  gastoId: string,
  moneda: string = "EUR",
  proveedor: string = "",
  deColaCorreo: boolean = false
): Promise<boolean> {
  try {
    const pendiente = await guardarConciliacionPendiente({ empresa, monto, fecha, descripcionGasto, chatId, gastoId, moneda, proveedor, deColaCorreo });
    await sendTelegramMessageWithButtons(
      chatId,
      `¿Quieres que intente conciliar el movimiento bancario correspondiente a "${descripcionGasto}"?`,
      [
        [
          { text: "🔗 Sí, conciliar", callback_data: `gasto_conciliar_si:${pendiente.id}` },
          { text: "❌ No, dejar así", callback_data: `gasto_conciliar_no:${pendiente.id}` },
        ],
      ]
    );
    return true;
  } catch (error) {
    console.error("[gastoCallbackHandler] Error preguntando si conciliar (no crítico):", error);
    return false;
  }
}

/**
 * Maneja los botones de propuestas de gasto (gasto_adjuntar / gasto_nuevo /
 * gasto_nuevo_conciliar / gasto_corregir / gasto_cancelar / gasto_conciliar_si
 * / gasto_conciliar_no). Los únicos caminos que escriben algo real en
 * Holded son gasto_adjuntar, gasto_nuevo y gasto_nuevo_conciliar (y la
 * confirmación tras gasto_corregir) — nunca ocurre automáticamente.
 */
export async function handleGastoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, propuestaId, extra] = data.split(":");

  if (accion === "gasto_cancelar") {
    const propuesta = await consumirPropuestaGasto(propuestaId);
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    if (propuesta) {
      await limpiarArchivoLocal(propuesta.rutaLocal);
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `❌ Cancelado — ${propuesta.proveedor} (${propuesta.monto} ${propuesta.moneda})`,
        []
      );
      if (propuesta.deColaCorreo) await avanzarColaCorreoSiActivo(propuesta.chatId);
    }
    return;
  }

  if (accion === "gasto_corregir") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — dime la empresa y el concepto correctos (ej. "EWORKS, servicio de limpieza").`,
      []
    );
    await guardarPendienteCorreccionGasto(propuesta.chatId, propuesta.id);
    return;
  }

  if (accion === "gasto_adjuntar" || accion === "gasto_nuevo" || accion === "gasto_nuevo_conciliar") {
    const propuesta = await consumirPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Procesando...");
    await editTelegramMessage(propuesta.chatId, propuesta.messageId, `🔄 Procesando "${propuesta.proveedor}"...`, []);

    let preguntaConciliacionPendiente = false;
    try {
      if (accion === "gasto_adjuntar") {
        const indice = Number(extra);
        const candidato = propuesta.candidatos[indice];
        if (!candidato) {
          throw new Error(`No se encontró el candidato #${indice + 1}.`);
        }

        // El gasto candidato YA EXISTE en Holded desde antes — un fallo al
        // adjuntar el comprobante nunca debe verse como un error total (no
        // se creó ni se rompió nada), mismo criterio que crearGastoYReportar
        // aplica cuando el gasto se acaba de crear.
        let notaComprobante = "";
        try {
          await adjuntarYLimpiar(propuesta, candidato.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[gastoCallbackHandler] Gasto ${candidato.id} ya existía pero falló adjuntar el comprobante:`, message);
          notaComprobante = `\n\n⚠️ No pude adjuntar el comprobante (${message}). Súbelo a mano en Holded (id ${candidato.id}) si tienes el archivo.`;
        }

        await registrarClasificacionAprendida(propuesta.proveedor, propuesta.empresa, propuesta.concepto).catch(
          (error) => console.error("[gastoCallbackHandler] No se pudo guardar la clasificación aprendida (no crítico):", error)
        );
        const notaConciliacion = await intentarConciliar(
          propuesta.empresa,
          propuesta.monto,
          propuesta.fecha,
          candidato.id,
          propuesta.moneda,
          propuesta.proveedor
        );

        await editTelegramMessage(
          propuesta.chatId,
          propuesta.messageId,
          `✅ Gasto de ${candidato.contactName} (${candidato.total.toFixed(2)} €, ${candidato.fecha}) en Holded` +
            (notaComprobante ? "." : " — comprobante adjuntado.") +
            `${notaComprobante}${notaConciliacion}`,
          []
        );
      } else {
        // gasto_nuevo_conciliar: procesarGastoEntrante ya confirmó un
        // movimiento bancario coincidente ANTES de proponer — suficiente
        // confianza para conciliar de una, sin pedir revisión previa.
        // gasto_nuevo: no había match confirmado — se crea nomás y se
        // pregunta DESPUÉS (preguntarSiConciliar), para que se revise en
        // Holded antes de conciliar.
        const conciliarInline = accion === "gasto_nuevo_conciliar";
        const resultado = await crearGastoYReportar(propuesta, propuesta.empresa, propuesta.concepto, undefined, conciliarInline);
        await editTelegramMessage(propuesta.chatId, propuesta.messageId, resultado.mensaje, []);
        if (resultado.conciliacionPendiente) {
          preguntaConciliacionPendiente = await preguntarSiConciliar(
            propuesta.chatId,
            resultado.conciliacionPendiente.empresa,
            resultado.conciliacionPendiente.monto,
            resultado.conciliacionPendiente.fecha,
            resultado.conciliacionPendiente.descripcionGasto,
            resultado.conciliacionPendiente.gastoId,
            resultado.conciliacionPendiente.moneda,
            resultado.conciliacionPendiente.proveedor,
            propuesta.deColaCorreo === true
          );
        }
      }
    } catch (error) {
      if (error instanceof ContactoNoEncontradoError) {
        await manejarContactoNoEncontrado(propuesta, propuesta.empresa, propuesta.concepto, propuesta.chatId, propuesta.messageId);
        return;
      }
      if (error instanceof FechaBloqueadaError) {
        await manejarFechaBloqueada(propuesta, propuesta.empresa, propuesta.concepto, error, propuesta.chatId, propuesta.messageId);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[gastoCallbackHandler] Error procesando gasto:", message);
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `⚠️ Error procesando "${propuesta.proveedor}"\n\n${message}\n\nEl archivo local no se borró — puedes reenviarlo.`,
        []
      );
      // No avanza la cola en el error — mejor dejarlo "activo" (visible,
      // pendiente) que marcar leído un correo cuyo gasto en realidad nunca
      // se creó. Mismo criterio que documentCallbackHandler.ts.
      return;
    }
    // Si se acaba de mandar la pregunta "¿conciliar?" (preguntaConciliacionPendiente=true),
    // crear el gasto es solo el primer paso — falta la decisión de conciliar
    // o no, así que la cola espera esa respuesta (ver gasto_conciliar_si/no
    // abajo) en vez de avanzar aquí. Pedido explícito de Carlos: verificar
    // que "crear el gasto y luego conciliar" cuenta como los dos pasos que
    // hacen falta para dar el correo por resuelto, no solo el primero — bug
    // real encontrado al revisar el código: antes avanzaba apenas se creaba
    // el gasto, dejando la pregunta de conciliación desconectada de la cola.
    if (propuesta.deColaCorreo && !preguntaConciliacionPendiente) await avanzarColaCorreoSiActivo(propuesta.chatId);
    return;
  }

  if (accion === "gasto_conciliar_si" || accion === "gasto_conciliar_no") {
    const pendiente = await consumirConciliacionPendiente(propuestaId);
    if (!pendiente) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible.");
      return;
    }

    if (accion === "gasto_conciliar_no") {
      await answerCallbackQuerySafe(callback.id, "Ok, no se concilia.");
      await sendTelegramMessage(pendiente.chatId, `Ok — "${pendiente.descripcionGasto}" queda sin conciliar.`);
      if (pendiente.deColaCorreo) await avanzarColaCorreoSiActivo(pendiente.chatId);
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Conciliando...");
    const notaConciliacion = await intentarConciliar(
      pendiente.empresa,
      pendiente.monto,
      pendiente.fecha,
      pendiente.gastoId,
      pendiente.moneda,
      pendiente.proveedor
    );
    await sendTelegramMessage(
      pendiente.chatId,
      notaConciliacion
        ? `"${pendiente.descripcionGasto}"${notaConciliacion}`
        : `No encontré ningún movimiento bancario sin conciliar que coincida con "${pendiente.descripcionGasto}" — revísalo a mano en Holded si crees que ya debería estar.`
    );
    if (pendiente.deColaCorreo) await avanzarColaCorreoSiActivo(pendiente.chatId);
    return;
  }

  if (accion === "gasto_usarcontacto") {
    const resolucion = await consumirResolucionContacto(propuestaId);
    if (!resolucion) {
      await answerCallbackQuerySafe(callback.id, "Esta selección ya no está disponible.");
      return;
    }
    const alternativa = resolucion.alternativas[Number(extra)];
    if (!alternativa) {
      await answerCallbackQuerySafe(callback.id, "Alternativa inválida.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Procesando...");
    await editTelegramMessage(resolucion.chatId, resolucion.messageId, `🔄 Procesando con "${alternativa.contactName}"...`, []);

    await procesarGastoConContactoResuelto(resolucion, { id: alternativa.contactId, name: alternativa.contactName });
    return;
  }

  if (accion === "gasto_crearsinproveedor") {
    const resolucion = await consumirResolucionContacto(propuestaId);
    if (!resolucion) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Procesando...");
    await editTelegramMessage(
      resolucion.chatId,
      resolucion.messageId,
      `🔄 Creando el gasto con el contacto genérico "PROVEEDOR SIN IDENTIFICAR"...`,
      []
    );

    const placeholder = CONTACTO_SIN_IDENTIFICAR_POR_EMPRESA[resolucion.empresaFinal];
    await procesarGastoConContactoResuelto(resolucion, placeholder, false);
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}

interface ResultadoCrearGasto {
  mensaje: string;
  /** Presente solo cuando conciliarInline=false — el llamador debe preguntar con preguntarSiConciliar. */
  conciliacionPendiente?: {
    empresa: Empresa;
    monto: number;
    fecha: string;
    descripcionGasto: string;
    gastoId: string;
    moneda: string;
    proveedor: string;
  };
}

/**
 * Crea el gasto en Holded (con el desglose de IVA de la propuesta), le
 * adjunta el comprobante, y devuelve el texto final para reportar — no
 * manda el mensaje él mismo, porque lo usan varios caminos distintos
 * (editar un mensaje existente vs. mandar uno nuevo tras una corrección).
 *
 * `conciliarInline` controla CUÁNDO se intenta conciliar el movimiento
 * bancario — pedido explícito de Carlos tras un caso real (factura de
 * Booking.com sin match de compra, pero sí había un cargo real en el
 * banco): si `procesarGastoEntrante` ya confirmó un movimiento coincidente
 * ANTES de proponer (candidato "gasto_nuevo_conciliar"), hay confianza
 * suficiente para conciliar de una, sin pedir revisión previa — se pasa
 * `conciliarInline=true`. Si no había match confirmado (el caso normal de
 * "gasto_nuevo"), se crea el gasto nomás y se devuelve
 * `conciliacionPendiente` para que el llamador pregunte DESPUÉS
 * (preguntarSiConciliar) — dando tiempo a revisar el gasto recién creado
 * en Holded antes de decidir, en vez de conciliar en silencio.
 *
 * Si no se pasa `contactoForzado` y no se encuentra el proveedor, lanza
 * ContactoNoEncontradoError en vez de devolver un texto de error — quien la
 * llame decide si ofrece alternativas (ver manejarContactoNoEncontrado) o
 * falla directo. Cuando SÍ se pasa `contactoForzado` (el usuario confirmó
 * una alternativa), se salta la búsqueda y además aprende el alias para que
 * la próxima factura de este proveedor resuelva directo — EXCEPTO cuando
 * `aprenderAlias=false` (usado para el contacto placeholder "PROVEEDOR SIN
 * IDENTIFICAR": aprenderlo como alias real dejaría CUALQUIER factura futura
 * de ese proveedor pegada al placeholder para siempre, incluso después de
 * crear el contacto real).
 */
async function crearGastoYReportar(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"],
  conceptoFinal: string,
  contactoForzado?: { id: string; name: string },
  conciliarInline: boolean = false,
  aprenderAlias: boolean = true
): Promise<ResultadoCrearGasto> {
  const contacto = contactoForzado ?? (await buscarContactoHolded(empresaFinal, propuesta.proveedor));
  if (!contacto) {
    throw new ContactoNoEncontradoError(propuesta.proveedor, empresaFinal);
  }

  // Con el contacto placeholder, el nombre real del proveedor NUNCA debe
  // perderse — va al frente de la descripción del gasto (visible en Holded)
  // aunque el contacto en sí sea genérico.
  const descripcionFinal =
    !aprenderAlias && contactoForzado
      ? `[Proveedor real: ${propuesta.proveedor}] ${conceptoFinal || propuesta.concepto}`
      : conceptoFinal || propuesta.concepto;

  const lineas =
    propuesta.lineas.length > 0
      ? propuesta.lineas
      : [{ concepto: descripcionFinal, base: propuesta.monto, tipoIvaPct: 0 }];

  const gasto = await crearGastoHolded(empresaFinal, {
    contactId: contacto.id,
    fecha: propuesta.fecha || new Date().toISOString().slice(0, 10),
    descripcion: descripcionFinal,
    lineas,
    cuentaId: propuesta.cuentaId,
    tags: propuesta.cuentaTags,
    moneda: propuesta.moneda,
  });

  // A partir de acá el gasto YA EXISTE en Holded — un fallo en cualquier
  // paso siguiente (adjuntar comprobante, aprendizaje) NUNCA debe lanzar
  // hacia arriba ni hacer parecer que no se creó nada. Bug real encontrado
  // en vivo: adjuntarYLimpiar lanzaba (archivo local no encontrado) y el
  // catch de más arriba mostraba "Error procesando..." con "puedes
  // reenviarlo" — pero el gasto YA estaba creado en Holded (confirmado en
  // Holded mismo), así que reenviar el documento habría creado un
  // DUPLICADO. Ahora se captura acá y se reporta con claridad qué sí y qué
  // no se logró, y el flujo sigue hasta la pregunta de conciliación.
  let notaComprobante = "";
  try {
    await adjuntarYLimpiar(propuesta, gasto.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[gastoCallbackHandler] Gasto ${gasto.id} creado pero falló adjuntar el comprobante:`, message);
    notaComprobante =
      `\n\n⚠️ No pude adjuntar el comprobante (${message}). El gasto YA está creado en Holded (id ${gasto.id}) — ` +
      `sube el comprobante a mano ahí, no reenvíes el documento o se duplicaría el gasto.`;
  }

  await registrarClasificacionAprendida(propuesta.proveedor, empresaFinal, conceptoFinal || propuesta.concepto).catch(
    (error) => console.error("[gastoCallbackHandler] No se pudo guardar la clasificación aprendida (no crítico):", error)
  );
  if (contactoForzado && aprenderAlias) {
    await registrarAliasProveedor(empresaFinal, propuesta.proveedor, contactoForzado.id, contactoForzado.name).catch(
      (error) => console.error("[gastoCallbackHandler] No se pudo guardar el alias de proveedor (no crítico):", error)
    );
  }

  const nombreContacto = contacto.name ?? propuesta.proveedor;
  const notaPlaceholder =
    !aprenderAlias && contactoForzado
      ? `\n\n⚠️ Se usó el contacto genérico "${nombreContacto}" porque "${propuesta.proveedor}" no está en Holded — ` +
        `el nombre real quedó en la descripción del gasto. Corrige el contacto a mano en Holded cuando exista.`
      : "";
  const baseMensaje =
    `✅ Gasto creado en Holded (id ${gasto.id}, contacto ${nombreContacto}, como borrador)` +
    (notaComprobante ? "." : " y comprobante adjuntado.") +
    notaComprobante +
    notaPlaceholder;

  if (conciliarInline) {
    // propuesta.proveedor (el texto real leído de la factura/correo, ej.
    // "Uber"), NO nombreContacto — bug real encontrado en auditoría:
    // nombreContacto puede ser el contacto genérico "PROVEEDOR SIN
    // IDENTIFICAR" (cuando no se encontró en Holded), que nunca va a
    // aparecer en la descripción de ningún movimiento bancario real, así
    // que la búsqueda aproximada nunca encontraba nada aunque el nombre
    // real (que sí se conocía) hubiera hecho match.
    const notaConciliacion = await intentarConciliar(
      empresaFinal,
      propuesta.monto,
      propuesta.fecha,
      gasto.id,
      propuesta.moneda,
      propuesta.proveedor
    );
    return { mensaje: `${baseMensaje}${notaConciliacion}` };
  }

  return {
    mensaje: baseMensaje,
    conciliacionPendiente: {
      empresa: empresaFinal,
      monto: propuesta.monto,
      fecha: propuesta.fecha,
      descripcionGasto: `${nombreContacto} — ${propuesta.monto} ${propuesta.moneda}`,
      gastoId: gasto.id,
      moneda: propuesta.moneda,
      // propuesta.proveedor, no nombreContacto — mismo motivo que arriba.
      proveedor: propuesta.proveedor,
    },
  };
}

/**
 * Reúne alternativas cuando no se encontró el proveedor por nombre: contactos
 * con nombre parecido, y proveedores con una factura ya registrada del MISMO
 * importe (resolviendo cada uno a su contact_id real). Deduplica por
 * contactId y se queda con hasta 5. Nunca decide sola cuál usar.
 */
async function construirAlternativasContacto(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"]
): Promise<AlternativaContacto[]> {
  const [porNombre, porMonto] = await Promise.all([
    buscarContactosParecidos(empresaFinal, propuesta.proveedor, 5),
    buscarComprasPorMonto(empresaFinal, propuesta.monto, propuesta.fecha, 15),
  ]);

  const alternativas: AlternativaContacto[] = [];
  const vistos = new Set<string>();

  for (const c of porNombre) {
    if (typeof c.id !== "string" || typeof c.name !== "string" || vistos.has(c.id)) continue;
    vistos.add(c.id);
    alternativas.push({ contactId: c.id, contactName: c.name, motivo: "nombre_parecido" });
  }

  for (const compra of porMonto) {
    if (vistos.size >= 5) break;
    let contacto: HoldedContact | undefined;
    try {
      contacto = await buscarContactoHolded(empresaFinal, compra.contactName);
    } catch (error) {
      console.error("[gastoCallbackHandler] Error resolviendo contacto de alternativa por importe:", error);
      continue;
    }
    if (!contacto || typeof contacto.id !== "string" || vistos.has(contacto.id)) continue;
    vistos.add(contacto.id);
    alternativas.push({
      contactId: contacto.id,
      contactName: contacto.name ?? compra.contactName,
      motivo: "mismo_importe",
      detalle: `factura del ${compra.fecha} por ${compra.total.toFixed(2)} €`,
    });
  }

  return alternativas.slice(0, 5);
}

/**
 * Cuando crearGastoYReportar lanza FechaBloqueadaError (Holded rechaza la
 * fecha por un periodo contable cerrado), en vez de mostrar el JSON crudo
 * del error, ofrece reintentar con la fecha de hoy — la propuesta original
 * ya se consumió (se borra ANTES de intentar crear, ver el flujo principal),
 * así que se crea una nueva con la misma info pero fecha=hoy, y un botón
 * que dispara gasto_nuevo sobre esa propuesta nueva. Si `messageId` viene
 * indefinido (ej. tras una corrección por texto libre), manda un mensaje
 * nuevo con los botones en vez de editar.
 */
async function manejarFechaBloqueada(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"],
  conceptoFinal: string,
  error: FechaBloqueadaError,
  chatId: number,
  messageId: number | undefined
): Promise<void> {
  const fechaHoy = new Date().toISOString().slice(0, 10);

  const { id: _idViejo, creadoEn: _creadoEnViejo, ...datosBase } = propuesta;
  const nuevaPropuesta = await crearPropuestaGasto({
    ...datosBase,
    empresa: empresaFinal,
    concepto: conceptoFinal || propuesta.concepto,
    fecha: fechaHoy,
  });

  const texto =
    `⚠️ No pude crear el gasto de "${propuesta.proveedor}" — Holded dice que la fecha ${propuesta.fecha} ` +
    `corresponde a un periodo contable ya cerrado/bloqueado.\n\n¿Lo registro con la fecha de hoy (${fechaHoy}) en su lugar?`;

  const botones = [
    [{ text: `✅ Sí, usar ${fechaHoy}`, callback_data: `gasto_nuevo:${nuevaPropuesta.id}` }],
    [{ text: "❌ Cancelar", callback_data: `gasto_cancelar:${nuevaPropuesta.id}` }],
  ];

  if (messageId != null) {
    await editTelegramMessage(chatId, messageId, texto, botones);
    await actualizarMessageIdGasto(nuevaPropuesta.id, messageId);
  } else {
    const mensajeIdFinal = await sendTelegramMessageWithButtons(chatId, texto, botones);
    await actualizarMessageIdGasto(nuevaPropuesta.id, mensajeIdFinal);
  }
}

/**
 * Crea el gasto usando un contacto YA resuelto (alternativa elegida por
 * botón, o el propio proveedor una vez que se confirma que ya existe en
 * Holded) — mismo camino tanto si viene de gasto_usarcontacto (botón) como
 * de reintentar_contacto_pendiente (el usuario escribió "ya lo creé" en el
 * chat, ver core/tools/reintentarContactoPendiente.ts). Extraído para no
 * duplicar el manejo de FechaBloqueadaError/conciliación entre los dos
 * caminos.
 */
export async function procesarGastoConContactoResuelto(
  resolucion: ResolucionContactoPendiente,
  contacto: { id: string; name: string },
  aprenderAlias: boolean = true
): Promise<void> {
  try {
    const resultado = await crearGastoYReportar(
      resolucion.propuesta,
      resolucion.empresaFinal,
      resolucion.conceptoFinal,
      contacto,
      false,
      aprenderAlias
    );
    await editTelegramMessage(resolucion.chatId, resolucion.messageId, resultado.mensaje, []);
    let preguntaConciliacionPendiente = false;
    if (resultado.conciliacionPendiente) {
      preguntaConciliacionPendiente = await preguntarSiConciliar(
        resolucion.chatId,
        resultado.conciliacionPendiente.empresa,
        resultado.conciliacionPendiente.monto,
        resultado.conciliacionPendiente.fecha,
        resultado.conciliacionPendiente.descripcionGasto,
        resultado.conciliacionPendiente.gastoId,
        resultado.conciliacionPendiente.moneda,
        resultado.conciliacionPendiente.proveedor,
        resolucion.propuesta.deColaCorreo === true
      );
    }
    // Ver comentario equivalente en el handler principal (handleGastoCallback) — crear el gasto no basta si todavía falta la decisión de conciliar.
    if (resolucion.propuesta.deColaCorreo && !preguntaConciliacionPendiente) await avanzarColaCorreoSiActivo(resolucion.chatId);
  } catch (error) {
    if (error instanceof FechaBloqueadaError) {
      await manejarFechaBloqueada(
        resolucion.propuesta,
        resolucion.empresaFinal,
        resolucion.conceptoFinal,
        error,
        resolucion.chatId,
        resolucion.messageId
      );
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error procesando gasto con contacto resuelto:", message);
    await editTelegramMessage(
      resolucion.chatId,
      resolucion.messageId,
      `⚠️ Error procesando "${resolucion.propuesta.proveedor}"\n\n${message}\n\nEl archivo local no se borró — puedes reenviarlo.`,
      []
    );
    // No avanza la cola en el error — mismo criterio que arriba.
  }
}

/**
 * Cuando crearGastoYReportar lanza ContactoNoEncontradoError, en vez de solo
 * decir "no lo encontré" busca alternativas (nombre parecido, mismo importe
 * ya registrado) y las ofrece por botones — el usuario confirma cuál es, o
 * "ninguna" para crear el contacto a mano en Holded. Si no hay alternativas,
 * cae al mensaje de error de siempre. Si `messageId` viene indefinido (no
 * hay un mensaje previo editable, ej. tras una corrección por texto libre),
 * manda uno nuevo con los botones en vez de editar.
 */
async function manejarContactoNoEncontrado(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"],
  conceptoFinal: string,
  chatId: number,
  messageId: number | undefined
): Promise<void> {
  const alternativas = await construirAlternativasContacto(propuesta, empresaFinal).catch((error) => {
    console.error("[gastoCallbackHandler] Error buscando alternativas de contacto:", error);
    return [] as AlternativaContacto[];
  });

  const encabezado =
    `⚠️ No encontré exactamente el proveedor "${propuesta.proveedor}" en los contactos de Holded (${empresaFinal}).`;

  // Pedido explícito de Carlos, tras un caso real (MERA AEROPUERTO DE
  // PANAMA SA, Footprint): sin esta opción, un proveedor no encontrado
  // bloqueaba el gasto indefinidamente hasta que alguien creara el contacto
  // real en Holded — incluso cuando lo urgente era conciliar el movimiento
  // bancario ya. "Crear sin proveedor" usa un contacto placeholder
  // reutilizable ("PROVEEDOR SIN IDENTIFICAR", ver
  // CONTACTO_SIN_IDENTIFICAR_POR_EMPRESA) — el nombre real del proveedor
  // queda en la descripción del gasto, nunca se pierde, y se puede
  // corregir a mano en Holded después. Disponible en AMBOS casos (con o
  // sin alternativas de nombre parecido).
  const botonSinProveedor = (resolucionId: string): InlineKeyboardButton[] => [
    { text: "🆗 Crear sin proveedor real", callback_data: `gasto_crearsinproveedor:${resolucionId}` },
  ];

  if (alternativas.length === 0) {
    // Pedido explícito de Carlos: si respondes en este mismo chat (ej. "ya
    // lo creé") en vez de reenviar la factura, el asistente debe reconocer
    // la pregunta pendiente y reintentar — antes esto no quedaba guardado
    // en ningún lado, así que una respuesta en texto libre no tenía cómo
    // conectarse con esta propuesta. Se guarda igual que el caso CON
    // alternativas (mismo store), solo que con alternativas=[] — el aviso
    // de que hay una resolución de contacto pendiente (buildSystemPromptDinamico)
    // y la tool reintentar_contacto_pendiente (core/tools/) hacen el resto.
    const textoFinal =
      `${encabezado}\n\nPuedes crearlo en Holded y avisarme aquí mismo (ej. "ya lo creé") — reintento solo, ` +
      `sin que tengas que reenviar la factura. O, si prefieres no esperar, uso un contacto genérico y dejo el ` +
      `nombre real en la descripción (lo corriges en Holded cuando quieras).`;

    const resolucion = await guardarResolucionContacto({
      propuesta,
      empresaFinal,
      conceptoFinal,
      alternativas: [],
      chatId,
      messageId: messageId ?? 0,
    });

    const botones: InlineKeyboardButton[][] = [botonSinProveedor(resolucion.id)];

    if (messageId != null) {
      await editTelegramMessage(chatId, messageId, textoFinal, botones);
    } else {
      const nuevoMessageId = await sendTelegramMessageWithButtons(chatId, textoFinal, botones);
      await actualizarMessageIdResolucionContacto(resolucion.id, nuevoMessageId).catch((error) =>
        console.error("[gastoCallbackHandler] Error actualizando messageId de la resolución pendiente:", error)
      );
    }
    return;
  }

  const mensajeIdFinal = messageId ?? (await sendTelegramMessageWithButtons(chatId, `${encabezado}\n\nBuscando alternativas...`, []));

  const resolucion = await guardarResolucionContacto({
    propuesta,
    empresaFinal,
    conceptoFinal,
    alternativas,
    chatId,
    messageId: mensajeIdFinal,
  });

  const etiquetaMotivo = (a: AlternativaContacto) =>
    a.motivo === "nombre_parecido" ? "nombre parecido" : `mismo importe — ${a.detalle}`;

  const texto =
    `${encabezado}\n\nEncontré estas alternativas — ¿alguna es la que debo registrar?\n\n` +
    alternativas.map((a, i) => `${i + 1}. ${a.contactName} (${etiquetaMotivo(a)})`).join("\n");

  const botones: InlineKeyboardButton[][] = alternativas.map((a, i) => [
    { text: `✅ ${a.contactName}`, callback_data: `gasto_usarcontacto:${resolucion.id}:${i}` },
  ]);
  botones.push(botonSinProveedor(resolucion.id));

  await editTelegramMessage(chatId, mensajeIdFinal, texto, botones);
}

/**
 * Continúa el flujo cuando el usuario responde con la corrección tras
 * pulsar "✏️ Corregir clasificación".
 */
export async function continuarConCorreccionGasto(pendiente: PendienteCorreccionGasto, textoUsuario: string): Promise<void> {
  // La corrección termina creando/escribiendo un gasto en Holded — mismo
  // filtro de rol que los botones de escritura (esAccionSensible en
  // server.ts), necesario aquí también porque este camino se dispara por
  // texto libre, no por un callback_data que ese filtro pueda interceptar.
  const rol = await obtenerRolUsuario(pendiente.chatId);
  if (rol !== "superadmin") {
    await sendTelegramMessage(pendiente.chatId, "Corregir y crear el gasto requiere aprobación del superadministrador.");
    return;
  }

  const propuesta = await consumirPropuestaGasto(pendiente.propuestaId);
  if (!propuesta) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible.");
    return;
  }

  const [empresaRaw, ...resto] = textoUsuario.split(",");
  const empresaCorregidaTexto = empresaRaw.trim().toUpperCase();
  const empresaFinal: PropuestaGasto["empresa"] =
    empresaCorregidaTexto === "WOBA" || empresaCorregidaTexto === "EWORKS" ? (empresaCorregidaTexto as PropuestaGasto["empresa"]) : propuesta.empresa;
  const conceptoFinal = resto.join(",").trim() || textoUsuario.trim();

  await sendTelegramMessage(pendiente.chatId, `🔄 Procesando "${propuesta.proveedor}" con la corrección...`);

  try {
    const resultado = await crearGastoYReportar(propuesta, empresaFinal, conceptoFinal);
    await sendTelegramMessage(propuesta.chatId, resultado.mensaje);
    let preguntaConciliacionPendiente = false;
    if (resultado.conciliacionPendiente) {
      preguntaConciliacionPendiente = await preguntarSiConciliar(
        propuesta.chatId,
        resultado.conciliacionPendiente.empresa,
        resultado.conciliacionPendiente.monto,
        resultado.conciliacionPendiente.fecha,
        resultado.conciliacionPendiente.descripcionGasto,
        resultado.conciliacionPendiente.gastoId,
        resultado.conciliacionPendiente.moneda,
        resultado.conciliacionPendiente.proveedor,
        propuesta.deColaCorreo === true
      );
    }
    // Ver comentario equivalente en el handler principal (handleGastoCallback) — crear el gasto no basta si todavía falta la decisión de conciliar.
    if (propuesta.deColaCorreo && !preguntaConciliacionPendiente) await avanzarColaCorreoSiActivo(propuesta.chatId);
  } catch (error) {
    if (error instanceof ContactoNoEncontradoError) {
      await manejarContactoNoEncontrado(propuesta, empresaFinal, conceptoFinal, propuesta.chatId, undefined);
      return;
    }
    if (error instanceof FechaBloqueadaError) {
      await manejarFechaBloqueada(propuesta, empresaFinal, conceptoFinal, error, propuesta.chatId, undefined);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error procesando corrección de gasto:", message);
    await sendTelegramMessage(pendiente.chatId, `⚠️ Error: ${message}\n\nEl archivo local no se borró — puedes reenviarlo.`);
    // No avanza la cola en el error — mismo criterio que arriba.
  }
}
