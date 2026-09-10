import { unlink } from "node:fs/promises";
import { conMutex } from "../utils/asyncMutex";
import {
  answerCallbackQuery,
  editTelegramMessage,
  editTelegramMessageReplyMarkup,
  sendTelegramMessage,
  sendTelegramMessageSmart,
  sendTelegramMessageWithButtons,
} from "../telegram/client";
import type { InlineKeyboardButton } from "../telegram/types";
import {
  consumirPropuestaGasto,
  obtenerPropuestaGasto,
  crearPropuestaGasto,
  actualizarMessageIdGasto,
  actualizarMontoPropuestaGasto,
  actualizarMonedaPropuestaGasto,
  actualizarFlagMovimientoBancarioGasto,
  actualizarMovimientosAmbiguosPropuestaGasto,
  actualizarSeleccionAccionesGasto,
  actualizarClasificacionPropuestaGasto,
  type PropuestaGasto,
} from "./gastoProposalSheet";
import {
  construirTecladoGasto,
  esAccionFinal,
  necesitaTexto,
  indiceCandidato,
  indiceMovimientoAmbiguo,
  etiquetaAccion,
  opcionesTecladoDesdePropuesta,
} from "./gastoTeclado";
import { guardarPendienteCorreccionGasto, type PendienteCorreccionGasto } from "./pendienteCorreccionGastoStore";
import {
  guardarPendienteAjusteMontoGasto,
  consumirPendienteAjusteMontoGasto,
  type PendienteAjusteMontoGasto,
} from "./pendienteAjusteMontoGastoStore";
import {
  guardarPendienteAccionGasto,
  consumirPendienteAccionGasto,
  type PendienteAccionGasto,
} from "./pendienteAccionGastoStore";
import { guardarPendienteSeleccionGasto, type PendienteSeleccionGasto } from "./pendienteSeleccionGastoStore";
import { registrarClasificacionAprendida } from "./clasificacionAprendidaSheet";
import { registrarAliasProveedor } from "./proveedorAliasSheet";
import { registrarAsignacionCuenta } from "../holded/asignacionCuentaLogSheet";
import { registrarGastoDesdeCorreo } from "./gastoPorCorreoStore";
import {
  guardarResolucionContacto,
  consumirResolucionContacto,
  actualizarMessageIdResolucionContacto,
  type AlternativaContacto,
  type ResolucionContactoPendiente,
} from "./contactoResolucionStore";
import { guardarConciliacionPendiente, consumirConciliacionPendiente } from "./conciliacionPendienteStore";
import { guardarConciliacionAmbiguaPendiente, consumirConciliacionAmbiguaPendiente } from "./conciliacionAmbiguaPendienteStore";
import {
  buscarContactoHolded,
  buscarContactosParecidos,
  buscarComprasPorMonto,
  buscarGastoSimilar,
  formatearCandidatosDuplicado,
  crearGastoHolded,
  adjuntarComprobanteHolded,
  buscarMovimientoSimilar,
  buscarMovimientoAproximado,
  obtenerMonedasCuentasReales,
  reconciliarMovimiento,
  estaMovimientoYaConciliado,
  ContactoNoEncontradoError,
  FechaBloqueadaError,
  PosibleDuplicadoGastoError,
  VerificacionDuplicadoFallidaError,
  type HoldedContact,
  type MovimientoBancarioCandidato,
  type PurchaseCandidato,
} from "../holded/write";
import { registrarMovimientoAmbiguoElegido, sugerirCandidatoAprendido } from "../holded/movimientoAmbiguoAprendidoSheet";
import { obtenerRolUsuario } from "../telegram/authorizedUsersSheet";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import { reDescargarAdjuntoSiFalta, regenerarComprobanteDesdeCuerpoSiFalta } from "../gmail/reDescargarAdjunto";
import { generarBorradorYOfrecer } from "../gmail/emailCallbackHandler";
import { obtenerCuerpoCompletoCorreo } from "../gmail/client";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import { askClaude, interpretarCorreccionGasto, type CorreccionGasto } from "../claude/client";
import type { Empresa } from "../holded/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import type { LineaFactura } from "../documental/extractInvoiceData";

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
  // Identificador interno de dispararDecisionFinal: no es un callback de Telegram.
  if (callbackQueryId.startsWith("seleccion_")) return;
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[gastoCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

async function limpiarArchivoLocal(rutaLocal: string): Promise<void> {
  await unlink(rutaLocal).catch(() => {}); // no crítico si ya no existe
}

/**
 * Adjunta el comprobante a un gasto de Holded y borra la copia local
 * temporal (solo si tuvo éxito).
 *
 * Pedido explícito de Carlos, tras un caso real: un gasto se creó en Holded
 * SIN su comprobante ("ENOENT: no such file or directory, open
 * '/app/tmp/uploads/...'") — "no hay gastos en la contabilidad que puedan
 * ser creados sin soporte, es ilegal". Causa raíz: la copia local del
 * adjunto no sobrevive un redeploy de Railway, pero la propuesta en Sheets
 * sí — así que un gasto que queda pendiente durante CUALQUIER redeploy
 * pierde su copia de trabajo, aunque el original siga intacto en Gmail. Si
 * el primer intento falla Y se sabe de qué mensaje/adjunto de Gmail vino
 * (origenAdjuntoGmail), se descarga de nuevo desde ahí antes de rendirse —
 * Gmail es la fuente durable, tmp/uploads solo una copia de trabajo. Si el
 * segundo intento también falla (o no hay origen de Gmail que reintentar,
 * ej. una foto subida por Telegram), se propaga el error tal cual, para que
 * el gasto que ya se creó quede claramente marcado como pendiente de
 * comprobante (ver revisarGastosSinComprobante.ts) en vez de darse por
 * cerrado sin serlo.
 */
async function adjuntarYLimpiar(propuesta: PropuestaGasto, purchaseId: string): Promise<void> {
  const adjuntar = (mimeType: string | undefined, nombreArchivo: string) =>
    adjuntarComprobanteHolded(propuesta.empresa, purchaseId, propuesta.rutaLocal, nombreArchivo, mimeType);

  try {
    await adjuntar(propuesta.mimeType, propuesta.nombreArchivoOriginal);
  } catch (error) {
    // Primer respaldo: era un adjunto REAL de Gmail (tiene attachmentId) — se vuelve a descargar el
    // MISMO archivo, así que su mimeType/nombre originales siguen siendo correctos. Segundo respaldo
    // (hallazgo real de auditoría, caso MARNAPA/GDL Pastriva): era un PDF SINTÉTICO generado del
    // cuerpo del correo (nunca tuvo attachmentId que recuperar), o el primer respaldo también falló —
    // se regenera desde cero con el cuerpo fresco de Gmail. Solo se propaga el error si NINGUNA de las
    // dos vías logra reponer el archivo.
    const recuperado = await reDescargarAdjuntoSiFalta(propuesta.rutaLocal, {
      mensajeIdGmail: propuesta.origenAdjuntoGmail?.mensajeIdGmail,
      attachmentIdGmail: propuesta.origenAdjuntoGmail?.attachmentIdGmail,
    });
    if (recuperado) {
      await adjuntar(propuesta.mimeType, propuesta.nombreArchivoOriginal);
    } else {
      const regenerado = await regenerarComprobanteDesdeCuerpoSiFalta(propuesta.rutaLocal, propuesta);
      if (!regenerado) throw error;
      // Hallazgo real de auditoría xhigh: el archivo regenerado es SIEMPRE un PDF nuevo — nunca hay
      // que reusar el mimeType/nombre del adjunto original (ej. "image/jpeg" de una foto real). Si se
      // reusaran, Holded terminaría guardando bytes de PDF etiquetados como imagen — un comprobante
      // corrupto en cualquier visor que confíe en el tipo declarado, sin ningún error visible.
      const nombreBase = propuesta.nombreArchivoOriginal.replace(/\.[^./]+$/, "");
      await adjuntar("application/pdf", `comprobante_${nombreBase}.pdf`);
    }
  }
  await limpiarArchivoLocal(propuesta.rutaLocal);
}

interface ResultadoIntentarConciliar {
  nota: string;
  /**
   * true si se mandó un mensaje aparte con botones para elegir entre varios movimientos parecidos
   * (ver ofrecerEleccionMovimientosAmbiguos) y todavía no hay respuesta — el llamador debe tratarlo
   * igual que conciliacionPendiente (no avanzar la cola de correo todavía, ver gasto_conciliar_elegir
   * / gasto_conciliar_elegir_no) para no dar el gasto por resuelto antes de tiempo.
   */
  esperandoEleccion: boolean;
}

/**
 * Caso real reportado por Carlos: con varios movimientos parecidos, esto devolvía un texto muerto
 * ("revísalo a mano en Holded") sin ningún medio para responder — justo lo que pidió evitar siempre
 * ("cada vez que hagas una pregunta que requiera de mi respuesta, debes darme el medio para
 * dármela"). Ahora guarda los candidatos (conciliacionAmbiguaPendienteStore) y manda un botón "🔗
 * Conciliar con #N" por cada uno — reutiliza conciliarContraMovimientoEspecifico (mismo chequeo de
 * doble-conciliación) para ejecutar el elegido, sin repetir la búsqueda que volvería a toparse con
 * la misma ambigüedad.
 */
async function ofrecerEleccionMovimientosAmbiguos(
  empresa: Empresa,
  gastoId: string,
  descripcionGasto: string,
  chatId: number,
  candidatos: MovimientoBancarioCandidato[],
  deColaCorreo: boolean,
  esAproximado: boolean,
  proveedor?: string
): Promise<ResultadoIntentarConciliar> {
  try {
    // Hallazgo real de auditoría xhigh (efficiency): guardarConciliacionAmbiguaPendiente y
    // sugerirCandidatoAprendido son independientes entre sí (ninguna depende del resultado de la
    // otra — la primera solo necesita los datos ya recibidos como parámetros, no `pendiente.id`) así
    // que no hay razón para esperarlas una tras otra antes de mandarle el mensaje a Carlos.
    const [pendiente, indiceSugerido] = await Promise.all([
      guardarConciliacionAmbiguaPendiente({ empresa, gastoId, descripcionGasto, chatId, candidatos, deColaCorreo, esAproximado, proveedor }),
      // Pedido explícito de Carlos ("que la práctica te vaya dando experticia"):
      // nunca decide sola (Carlos siempre elige con el botón, es dinero), solo
      // resalta con ⭐ la opción que ya coincidió con algo confirmado antes
      // para este proveedor — para que elegir sea más rápido, sin tener que
      // leer las descripciones bancarias crudas cada vez.
      proveedor
        ? sugerirCandidatoAprendido(proveedor, empresa, candidatos).catch((error) => {
            console.error("[gastoCallbackHandler] Error consultando sugerencia aprendida de conciliación (no crítico):", error);
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);
    const filas: InlineKeyboardButton[][] = candidatos.map((_, i) => [
      {
        text: `${i === indiceSugerido ? "⭐ " : ""}🔗 Conciliar con #${i + 1}`,
        callback_data: `gasto_conciliar_elegir:${pendiente.id}:${i}`,
      },
    ]);
    filas.push([{ text: "❌ Ninguno, dejar así", callback_data: `gasto_conciliar_elegir_no:${pendiente.id}` }]);
    const notaSugerido = indiceSugerido !== undefined ? `\n\n⭐ La opción ${indiceSugerido + 1} coincide con conciliaciones anteriores de este proveedor.` : "";
    await sendTelegramMessageWithButtons(
      chatId,
      `💳 Encontré ${candidatos.length} movimientos bancarios${esAproximado ? " parecidos (nombre y monto cercanos, no exactos)" : " sin conciliar parecidos"} para "${descripcionGasto}":\n` +
        candidatos.map((m, i) => `  ${i + 1}. "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} ${m.moneda} (${m.fecha})`).join("\n") +
        notaSugerido +
        `\n\n¿Con cuál concilio?`,
      filas
    );
    return {
      nota: `\n\n💳 Encontré ${candidatos.length} movimientos parecidos — te mandé aparte los botones para elegir con cuál conciliar (o descartarlo).`,
      esperandoEleccion: true,
    };
  } catch (error) {
    console.error("[gastoCallbackHandler] Error ofreciendo elección de movimientos ambiguos (no crítico):", error);
    return { nota: `\n\n💳 Hay ${candidatos.length} movimientos bancarios parecidos — revísalo a mano en Holded.`, esperandoEleccion: false };
  }
}

/**
 * Tras crear/adjuntar un gasto con soporte real, intenta cerrar el círculo
 * conciliando el movimiento bancario correspondiente — solo si hay
 * exactamente un candidato sin conciliar con monto/fecha cercanos (nunca
 * adivina entre varios; si hay varios, ofrece elegir, ver
 * ofrecerEleccionMovimientosAmbiguos). Siempre relee el movimiento para
 * confirmar el estado real (ver reconciliarMovimiento) — el texto que
 * devuelve refleja lo que se pudo confirmar, nunca asume éxito. Nunca lanza:
 * un fallo aquí no debe tumbar el flujo principal de creación/adjunto, que
 * ya tuvo éxito.
 */
async function intentarConciliar(
  empresa: Empresa,
  monto: number,
  fecha: string,
  gastoId: string,
  chatId: number,
  descripcionGasto: string,
  moneda: string = "EUR",
  proveedor?: string,
  deColaCorreo: boolean = false
): Promise<ResultadoIntentarConciliar> {
  try {
    const fechaBusqueda = fecha || new Date().toISOString().slice(0, 10);
    const candidatos = await buscarMovimientoSimilar(empresa, { monto, fecha: fechaBusqueda, moneda });

    let candidato: Awaited<ReturnType<typeof buscarMovimientoSimilar>>[number] | undefined;
    let esAproximado = false;

    if (candidatos.length === 1) {
      candidato = candidatos[0];
    } else if (candidatos.length > 1) {
      return await ofrecerEleccionMovimientosAmbiguos(empresa, gastoId, descripcionGasto, chatId, candidatos, deColaCorreo, false, proveedor);
    } else if (proveedor) {
      // Mismo fallback que procesarGastoEntrante.ts (ver ese archivo para el
      // caso real que lo motivó): el match exacto puede no encontrar nada
      // cuando el equivalente en EUR de la factura es una estimación.
      const aproximados = await buscarMovimientoAproximado(empresa, { monto, fecha: fechaBusqueda, moneda, proveedor });
      if (aproximados.length === 1) {
        candidato = aproximados[0];
        esAproximado = true;
      } else if (aproximados.length > 1) {
        return await ofrecerEleccionMovimientosAmbiguos(empresa, gastoId, descripcionGasto, chatId, aproximados, deColaCorreo, true, proveedor);
      }
    }

    if (!candidato) return { nota: "", esperandoEleccion: false };

    // Reutiliza conciliarContraMovimientoEspecifico en vez de repetir la llamada a
    // reconciliarMovimiento acá — hallazgo real de auditoría: esta rama llamaba a
    // reconciliarMovimiento DIRECTO, sin el chequeo de estaMovimientoYaConciliado que la otra ruta
    // (checkboxes "🔗 Conciliar con #N") sí tiene, una inconsistencia real entre dos caminos que
    // hacen la misma acción con dinero real.
    const nota = await conciliarContraMovimientoEspecifico(empresa, candidato, gastoId, esAproximado);
    return { nota, esperandoEleccion: false };
  } catch (error) {
    console.error("[gastoCallbackHandler] Error intentando conciliar movimiento bancario:", error);
    return { nota: "", esperandoEleccion: false };
  }
}

/**
 * Concilia DIRECTO contra un movimiento ya identificado (accountId+movementId conocidos) — sin
 * buscar de nuevo. Pedido explícito de Carlos, tras un caso real: con varios movimientos ambiguos,
 * la única forma de elegir era responder en texto libre, incompatible con marcar los checks del
 * teclado al mismo tiempo — ahora Carlos elige CUÁL con un check (🔗 Conciliar con #N,
 * PropuestaGasto.movimientosAmbiguos), y esta función concilia justo contra ESE, sin repetir la
 * búsqueda (que volvería a toparse con la misma ambigüedad, ver intentarConciliar).
 */
async function conciliarContraMovimientoEspecifico(
  empresa: Empresa,
  movimiento: MovimientoBancarioCandidato,
  gastoId: string,
  /**
   * Hallazgo real de auditoría: cuando el candidato elegido venía del fallback aproximado
   * (buscarMovimientoAproximado — nombre y monto parecidos, NO exactos), esa advertencia se perdía
   * antes de llegar acá y el mensaje final sonaba tan seguro como un match exacto. Mismo texto que
   * ya usa intentarConciliar para su propio candidato único aproximado.
   */
  esAproximado: boolean = false,
  /**
   * Pedido explícito de Carlos ("que la práctica te vaya dando experticia") —
   * cuando se da (solo desde el camino de "🔗 Conciliar con #N" sobre una
   * ambigüedad REAL, ver gasto_conciliar_elegir), y la conciliación de
   * verdad tiene éxito, registra qué descripción de movimiento fue la
   * correcta para este proveedor (ver movimientoAmbiguoAprendidoSheet.ts) —
   * nunca decide nada, solo alimenta la sugerencia ⭐ de la próxima vez.
   */
  proveedorParaAprender?: string
): Promise<string> {
  const notaAprox = esAproximado ? " — coincidencia APROXIMADA (nombre y monto parecidos, no exactos), confírmalo en Holded" : "";
  try {
    const yaConciliado = await estaMovimientoYaConciliado(empresa, movimiento.accountId, movimiento.movementId, movimiento.fecha);
    if (yaConciliado) {
      return (
        `\n\n⚠️ Elegiste conciliar contra "${movimiento.descripcion || "sin descripción"}" (${movimiento.monto.toFixed(2)} ${movimiento.moneda}) ` +
        `pero ese movimiento ya quedó conciliado por otra vía mientras esperaba tu aprobación — revísalo a mano en Holded.`
      );
    }

    const resultado = await reconciliarMovimiento(empresa, movimiento.accountId, movimiento.movementId, movimiento.fecha, gastoId);

    if (resultado.ok) {
      if (proveedorParaAprender && movimiento.descripcion) {
        await registrarMovimientoAmbiguoElegido(proveedorParaAprender, empresa, movimiento.descripcion).catch((error) =>
          console.error("[gastoCallbackHandler] Error registrando aprendizaje de conciliación ambigua (no crítico):", error)
        );
      }
      // Hallazgo real de auditoría (caso Salesmate/RapidOps, Footprint): el movimiento bancario puede
      // quedar marcado como conciliado por completo (esto de arriba) mientras la COMPRA misma, del
      // lado de Holded, queda con un saldo pendiente ficticio — comportamiento real de Holded al
      // aplicar el equivalente en EUR en vez del monto nativo para documentos en otra moneda. Nunca se
      // reporta éxito sin más cuando eso pasa — se avisa explícitamente para que se revise a mano.
      const notaPendiente =
        resultado.pendienteEnCompra !== undefined
          ? `\n\n⚠️ OJO: el movimiento quedó conciliado por completo, pero la compra en Holded sigue mostrando ` +
            `${resultado.pendienteEnCompra.toFixed(2)} pendiente de pago — es un comportamiento conocido de Holded con ` +
            `documentos en moneda distinta a EUR (aplica el equivalente en EUR en vez del monto real). Revísalo a mano ` +
            `en Holded (sección Pagos del documento) para corregir el saldo.`
          : "";
      return (
        `\n\n💳 Movimiento bancario conciliado y enlazado al gasto (${movimiento.descripcion || "sin descripción"}, ` +
        `${movimiento.monto.toFixed(2)} ${movimiento.moneda}, enlazado por ${resultado.montoEnlazado.toFixed(2)} ${movimiento.moneda})${notaAprox}.${notaPendiente}`
      );
    }
    return (
      `\n\n⚠️ Elegiste conciliar contra "${movimiento.descripcion || "sin descripción"}" (${movimiento.monto.toFixed(2)} ${movimiento.moneda}) ` +
      `pero no pude confirmar que quedó conciliado Y enlazado al gasto (estado: ${resultado.statusFinal}, monto enlazado: ` +
      `${resultado.montoEnlazado.toFixed(2)} ${movimiento.moneda}) — revísalo a mano en Holded.`
    );
  } catch (error) {
    console.error("[gastoCallbackHandler] Error conciliando contra el movimiento elegido:", error);
    return `\n\n⚠️ El gasto se creó, pero hubo un error al conciliar contra "${movimiento.descripcion || "sin descripción"}" — revísalo a mano en Holded.`;
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
  deColaCorreo: boolean = false,
  mensajeIdGmail?: string
): Promise<boolean> {
  try {
    const pendiente = await guardarConciliacionPendiente({
      empresa,
      monto,
      fecha,
      descripcionGasto,
      chatId,
      gastoId,
      moneda,
      proveedor,
      deColaCorreo,
      mensajeIdGmail,
    });
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

  // Pedido explícito de Carlos, tras un caso real: una cuota de comunidad
  // se paga a medias con otra parte, así que el gasto a registrar es solo
  // la MITAD del importe real de la factura — no había ninguna forma de
  // ajustar el monto antes de crear el gasto. A diferencia de
  // "gasto_corregir" (que SÍ le quita los botones al mensaje original,
  // porque ahí la respuesta de texto libre reemplaza tanto empresa como
  // concepto), esto NO le toca los botones — solo LEE la propuesta
  // (obtenerPropuestaGasto, sin consumir) y actualiza el monto/líneas
  // guardados. "✅ Crear gasto en Holded" sigue arriba y funciona igual de
  // bien después: como crea el gasto releyendo la propuesta por su id en
  // el momento del click (consumirPropuestaGasto), automáticamente recoge
  // el monto ya corregido sin que haga falta reenviar nada.
  if (accion === "gasto_ajustarmonto") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id);
    // Bug real de auditoría (2026-09-03): este botón (mensaje VIEJO, ya en
    // vuelo desde antes del teclado de selección) dejaba los DEMÁS botones
    // del mismo mensaje intactos — incluido "✏️ Corregir clasificación",
    // que SÍ crea el gasto de inmediato al responder. Si Carlos tocaba los
    // dos y luego respondía un monto, la respuesta podía caer en el
    // pendiente de corrección equivocado (server.ts revisa esa cola
    // primero) y crear el gasto con un concepto basura. Se quita el
    // teclado de este mensaje al usar cualquiera de sus botones — mismo
    // criterio que gasto_corregir, para que solo uno pueda usarse por
    // mensaje viejo.
    await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
      console.error("[gastoCallbackHandler] Error quitando el teclado del mensaje viejo (no crítico):", error)
    );
    await guardarPendienteAjusteMontoGasto(propuesta.chatId, propuesta.id);
    await sendTelegramMessage(
      propuesta.chatId,
      `💰 Ok — dime el monto real a registrar para "${propuesta.proveedor}" (ej. "251.30", o "la mitad" de ` +
        `${propuesta.monto} ${propuesta.moneda}).`
    );
    return;
  }

  // Pedido explícito de Carlos, tras un caso real (INDUBUILDING LUARCA): una
  // factura por correo solo dejaba registrar el gasto, sin poder ADEMÁS
  // responder ese correo, guardarlo como conocimiento o dejar un
  // recordatorio — "puede ser 1 sola cosa... o pueden ser varias". Estas tres
  // ramas quedan para mensajes VIEJOS ya en vuelo con los botones standalone
  // de antes del teclado de selección — solo existían cuando
  // propuesta.correoOrigen venía seteado (ver construirTecladoGasto en
  // gastoTeclado.ts para el teclado nuevo, que ya no manda estos botones).
  if (accion === "gasto_responder") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta || !propuesta.correoOrigen) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Redactando...");
    // Mismo criterio que gasto_ajustarmonto arriba — se quita el teclado del
    // mensaje viejo al usar cualquiera de sus botones, para que no queden
    // dos pendientes de texto libre vivos a la vez sobre la misma propuesta.
    await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
      console.error("[gastoCallbackHandler] Error quitando el teclado del mensaje viejo (no crítico):", error)
    );
    await ejecutarResponderCorreo(propuesta);
    return;
  }

  if (accion === "gasto_guardarconocimiento") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta || !propuesta.correoOrigen) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Leyendo el correo...");
    await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
      console.error("[gastoCallbackHandler] Error quitando el teclado del mensaje viejo (no crítico):", error)
    );
    await ejecutarGuardarConocimiento(propuesta);
    return;
  }

  if (accion === "gasto_otrasacciones") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta || !propuesta.correoOrigen) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id);
    await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
      console.error("[gastoCallbackHandler] Error quitando el teclado del mensaje viejo (no crítico):", error)
    );
    await sendTelegramMessage(
      propuesta.chatId,
      `✏️ Ok — dime qué más quieres hacer con el correo "${propuesta.correoOrigen.asunto}" de ${propuesta.correoOrigen.de} ` +
        `(ej. "prográmame un recordatorio para conciliar mañana", o combina varias cosas en el mismo mensaje).`
    );
    await guardarPendienteAccionGasto(propuesta.chatId, propuesta.id);
    return;
  }

  if (accion === "gasto_toggle") {
    await handleGastoToggleCallback(callback, propuestaId, extra);
    return;
  }

  if (accion === "gasto_aprobar") {
    await handleGastoAprobarCallback(callback, propuestaId);
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
        const { nota: notaConciliacion, esperandoEleccion } = await intentarConciliar(
          propuesta.empresa,
          propuesta.monto,
          propuesta.fecha,
          candidato.id,
          propuesta.chatId,
          `${candidato.contactName} — ${propuesta.monto} ${propuesta.moneda}`,
          propuesta.moneda,
          propuesta.proveedor,
          propuesta.deColaCorreo === true
        );
        preguntaConciliacionPendiente = esperandoEleccion;

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
        // "gasto_nuevo_conciliar:<id>:<indice>" — variante con índice, para conciliar contra un
        // candidato AMBIGUO específico que Carlos eligió con el check "🔗 Conciliar con #N" (ver
        // PropuestaGasto.movimientosAmbiguos) — sin esto, conciliarInline volvería a buscar en
        // genérico y toparía con la MISMA ambigüedad que ya se le pidió elegir.
        const indiceMovAmbiguo = extra !== undefined && extra !== "" ? Number(extra) : undefined;
        const movimientoObjetivo =
          indiceMovAmbiguo !== undefined && Number.isFinite(indiceMovAmbiguo)
            ? propuesta.movimientosAmbiguos?.[indiceMovAmbiguo]
            : undefined;
        const resultado = await crearGastoYReportar(propuesta, propuesta.empresa, propuesta.concepto, undefined, conciliarInline, true, movimientoObjetivo);
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
            propuesta.deColaCorreo === true,
            propuesta.correoOrigen?.mensajeIdGmail
          );
        } else if (resultado.esperandoEleccionConciliacion) {
          preguntaConciliacionPendiente = true;
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
      if (error instanceof PosibleDuplicadoGastoError) {
        await editTelegramMessage(propuesta.chatId, propuesta.messageId, mensajeDuplicadoDetectado(error.candidatos), []);
        return;
      }
      if (error instanceof VerificacionDuplicadoFallidaError) {
        await editTelegramMessage(propuesta.chatId, propuesta.messageId, mensajeVerificacionDuplicadoFallida(error), []);
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
    const { nota: notaConciliacion, esperandoEleccion } = await intentarConciliar(
      pendiente.empresa,
      pendiente.monto,
      pendiente.fecha,
      pendiente.gastoId,
      pendiente.chatId,
      pendiente.descripcionGasto,
      pendiente.moneda,
      pendiente.proveedor,
      pendiente.deColaCorreo === true
    );
    // Si intentarConciliar mandó los botones de "🔗 Conciliar con #N" aparte (esperandoEleccion),
    // ese mensaje YA incluye la nota — no repetirla acá para no duplicar la pregunta.
    if (!esperandoEleccion) {
      await sendTelegramMessage(
        pendiente.chatId,
        notaConciliacion
          ? `"${pendiente.descripcionGasto}"${notaConciliacion}`
          : `No encontré ningún movimiento bancario sin conciliar que coincida con "${pendiente.descripcionGasto}" — revísalo a mano en Holded si crees que ya debería estar.`
      );
    }
    // Igual que preguntaConciliacionPendiente arriba: si quedó esperando que Carlos elija cuál,
    // la cola de correo espera esa respuesta (ver gasto_conciliar_elegir/_no) en vez de avanzar ya.
    if (pendiente.deColaCorreo && !esperandoEleccion) await avanzarColaCorreoSiActivo(pendiente.chatId);
    return;
  }

  // Respuesta a los botones que manda ofrecerEleccionMovimientosAmbiguos cuando intentarConciliar
  // encuentra varios movimientos parecidos — caso real reportado por Carlos, ver esa función.
  if (accion === "gasto_conciliar_elegir" || accion === "gasto_conciliar_elegir_no") {
    const pendiente = await consumirConciliacionAmbiguaPendiente(propuestaId);
    if (!pendiente) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible.");
      return;
    }

    if (accion === "gasto_conciliar_elegir_no") {
      await answerCallbackQuerySafe(callback.id, "Ok, no se concilia.");
      await sendTelegramMessage(pendiente.chatId, `Ok — "${pendiente.descripcionGasto}" queda sin conciliar.`);
      if (pendiente.deColaCorreo) await avanzarColaCorreoSiActivo(pendiente.chatId);
      return;
    }

    const indice = Number(extra);
    const movimiento = pendiente.candidatos[indice];
    if (!movimiento) {
      await answerCallbackQuerySafe(callback.id, "Movimiento inválido.");
      // Hallazgo real de auditoría: sin esto, un índice inválido (ej. candidatosJSON corrupto)
      // dejaba la pregunta consumida (ya se borró arriba) pero la cola de correo esperando para
      // siempre una respuesta que nunca va a llegar — mismo criterio que gasto_conciliar_elegir_no.
      if (pendiente.deColaCorreo) await avanzarColaCorreoSiActivo(pendiente.chatId);
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Conciliando...");
    const notaConciliacion = await conciliarContraMovimientoEspecifico(pendiente.empresa, movimiento, pendiente.gastoId, pendiente.esAproximado, pendiente.proveedor);
    await sendTelegramMessage(pendiente.chatId, `"${pendiente.descripcionGasto}"${notaConciliacion}`);
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

/**
 * Marca/desmarca un check del teclado de selección (ver gastoTeclado.ts) —
 * pedido explícito de Carlos, tras probar la primera versión con botones
 * que actuaban al toque: "al presionar una [alternativa] ya se elimina la
 * posibilidad de irse por otra... deberás dejar la posibilidad de activar
 * una o varias y luego aprobar". NUNCA ejecuta nada — solo actualiza
 * seleccionAcciones y repinta el MISMO mensaje (editTelegramMessageReplyMarkup,
 * nunca editTelegramMessage, para no tocar el texto original de la propuesta).
 */
async function handleGastoToggleCallback(callback: TelegramCallbackQuery, propuestaId: string, key: string | undefined): Promise<void> {
  if (!key) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const propuesta = await obtenerPropuestaGasto(propuestaId);
  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
    return;
  }

  const seleccion = new Set(propuesta.seleccionAcciones ?? []);
  if (esAccionFinal(key)) {
    // Grupo mutuamente excluyente (crear/crearconciliar/cancelar/nuevo/adjuntar_<i>)
    // — marcar uno desmarca cualquier otro del mismo grupo, como un radio button.
    if (seleccion.has(key)) {
      seleccion.delete(key);
    } else {
      for (const k of Array.from(seleccion)) if (esAccionFinal(k)) seleccion.delete(k);
      seleccion.add(key);
    }
  } else if (seleccion.has(key)) {
    seleccion.delete(key);
  } else {
    seleccion.add(key);
  }

  const nuevaSeleccion = Array.from(seleccion);
  await actualizarSeleccionAccionesGasto(propuesta.id, nuevaSeleccion);
  await answerCallbackQuerySafe(callback.id);

  const propuestaActualizada: PropuestaGasto = { ...propuesta, seleccionAcciones: nuevaSeleccion };
  const teclado = construirTecladoGasto(propuestaActualizada, opcionesTecladoDesdePropuesta(propuesta));
  await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, teclado).catch((error) =>
    console.error("[gastoCallbackHandler] Error repintando el teclado de selección (no crítico):", error)
  );
}

/**
 * Pregunta a mostrar para cada acción que necesita texto libre — reutilizada
 * tanto por "▶️ Aprobar selección" (primera pregunta) como por
 * continuarConSeleccionGasto (preguntas siguientes en la misma cola).
 */
function preguntaParaAccion(key: string, propuesta: PropuestaGasto): string {
  switch (key) {
    case "corregir":
      return `✏️ Corregir clasificación — dime la empresa y el concepto correctos (ej. "EWORKS, servicio de limpieza").`;
    case "ajustarmonto":
      return (
        `💰 Ajustar monto — dime el monto real a registrar para "${propuesta.proveedor}" (ej. "251.30", o "la mitad" ` +
        `de ${propuesta.monto} ${propuesta.moneda}) — o, si la MONEDA es la que está mal (ej. "esto fue en euros, no ` +
        `dólares"), dímelo así también.`
      );
    case "otrasacciones":
      return (
        `✏️ Otras acciones — dime qué más quieres hacer con el correo "${propuesta.correoOrigen?.asunto ?? ""}" ` +
        `(ej. "prográmame un recordatorio para conciliar mañana", o combina varias cosas en el mismo mensaje).`
      );
    default:
      return `Dime lo que falta para "${etiquetaAccion(key)}".`;
  }
}

/**
 * "Dispara" una decisión final (crear/crear y conciliar/cancelar/adjuntar a
 * un candidato/crear nuevo) RECICLANDO tal cual el código ya existente y
 * auditado de gasto_nuevo/gasto_nuevo_conciliar/gasto_cancelar/gasto_adjuntar
 * — arma un callback_data equivalente y lo pasa por handleGastoCallback de
 * nuevo, en vez de reimplementar esa lógica (manejo de contacto no
 * encontrado, fecha bloqueada, pregunta de conciliar, avance de la cola de
 * correo...) por segunda vez. `from`/`id` son placeholders: handleGastoCallback
 * nunca los lee (solo lee `data`). answerCallbackQuerySafe reconoce estos ids
 * internos y no realiza una solicitud inválida a Telegram.
 */
async function dispararDecisionFinal(propuesta: PropuestaGasto, decisionKey: string): Promise<void> {
  const indice = indiceCandidato(decisionKey);
  // "crearconciliar_<i>" — conciliar contra un candidato AMBIGUO específico (ver
  // PropuestaGasto.movimientosAmbiguos) — reutiliza el mismo accion "gasto_nuevo_conciliar" con el
  // índice como "extra" (mismo mecanismo que "gasto_adjuntar:<id>:<indice>"), en vez de un accion
  // nuevo — el índice ausente sigue siendo el caso original (un solo match, ya confirmado antes).
  const indiceMovAmbiguo = indiceMovimientoAmbiguo(decisionKey);
  const data =
    decisionKey === "crear" || decisionKey === "nuevo"
      ? `gasto_nuevo:${propuesta.id}`
      : decisionKey === "crearconciliar"
        ? `gasto_nuevo_conciliar:${propuesta.id}`
        : indiceMovAmbiguo !== undefined
          ? `gasto_nuevo_conciliar:${propuesta.id}:${indiceMovAmbiguo}`
          : decisionKey === "cancelar"
            ? `gasto_cancelar:${propuesta.id}`
            : indice !== undefined
              ? `gasto_adjuntar:${propuesta.id}:${indice}`
              : undefined;
  if (!data) return;

  await handleGastoCallback({
    id: `seleccion_${propuesta.id}_${Date.now()}`,
    from: { id: propuesta.chatId, is_bot: false },
    data,
  });
}

/**
 * "▶️ Aprobar selección" — ejecuta TODO lo marcado en el teclado de
 * selección, junto. Pedido explícito de Carlos: "activar una o varias y
 * luego aprobar para que la inteligencia del sistema proceda". Orden fijo,
 * pensado para que una decisión final (Crear/Cancelar) siempre use los
 * datos YA corregidos/ajustados, nunca los originales:
 * 1) Side-actions sin texto (responder/guardarconocimiento) — se disparan
 *    ya mismo, no dependen de ningún otro campo de la propuesta.
 * 2) Side-actions con texto (corregir, ajustarmonto, otrasacciones) — se
 *    piden de a una, nunca todas juntas (ver pendienteSeleccionGastoStore.ts).
 * 3) Decisión final (crear/crear y conciliar/cancelar/adjuntar/nuevo) — se
 *    dispara AL FINAL, una vez vacía la cola de texto (o de inmediato si no
 *    había ninguna acción de texto marcada).
 */
async function handleGastoAprobarCallback(callback: TelegramCallbackQuery, propuestaId: string): Promise<void> {
  const propuesta = await obtenerPropuestaGasto(propuestaId);
  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
    return;
  }

  const seleccion = propuesta.seleccionAcciones ?? [];
  if (seleccion.length === 0) {
    await answerCallbackQuerySafe(callback.id, "No marcaste ninguna acción todavía — marca al menos una y vuelve a aprobar.");
    return;
  }

  await answerCallbackQuerySafe(callback.id, "Aplicando...");

  // Pedido explícito de Carlos, tras el aviso de que un doble-toque en este
  // botón podría disparar dos veces algo sin texto: el botón queda INACTIVO
  // de inmediato — se le quita el teclado (editTelegramMessageReplyMarkup,
  // nunca toca el texto original de la propuesta, así no hace falta guardarlo
  // para restaurarlo después) ANTES de cualquier otro await, así que un
  // segundo toque sobre el mismo mensaje ya no tiene ningún botón que
  // presionar — cierra la ventana de la condición de carrera en vez de solo
  // avisar de que existe. El aviso de "procesando" va en un mensaje NUEVO
  // (no reemplaza el texto de la propuesta, que Carlos puede querer seguir
  // viendo con su desglose completo).
  await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
    console.error("[gastoCallbackHandler] Error quitando el teclado antes de aplicar (no crítico):", error)
  );
  await sendTelegramMessage(propuesta.chatId, "🔄 Aplicando tu selección...").catch((error) =>
    console.error("[gastoCallbackHandler] Error avisando que se está procesando (no crítico):", error)
  );

  // Se limpia de inmediato — evita que una futura aprobación (ej. tras
  // decidir Crear más tarde, con el teclado ya repuesto) vuelva a disparar
  // responder/guardarconocimiento una SEGUNDA vez.
  await actualizarSeleccionAccionesGasto(propuesta.id, []).catch((error) =>
    console.error("[gastoCallbackHandler] Error limpiando la selección aplicada (no crítico):", error)
  );

  const resumen: string[] = [];

  // propuesta.correoOrigen: por el teclado real (construirTecladoGasto) estos
  // dos checks solo existen cuando hay correoOrigen — el guard es defensivo
  // (ej. un callback_data armado a mano) para no reportar "ya en camino"
  // cuando ejecutarResponderCorreo/ejecutarGuardarConocimiento en realidad
  // no hicieron nada (las dos ya no-opean en silencio sin correoOrigen).
  if (seleccion.includes("responder") && propuesta.correoOrigen) {
    await ejecutarResponderCorreo(propuesta).catch((error) =>
      console.error("[gastoCallbackHandler] Error ejecutando 'Responder correo' desde Aprobar selección:", error)
    );
    resumen.push("✉️ Responder correo — ya en camino.");
  }
  if (seleccion.includes("guardarconocimiento") && propuesta.correoOrigen) {
    await ejecutarGuardarConocimiento(propuesta).catch((error) =>
      console.error("[gastoCallbackHandler] Error ejecutando 'Guardar como conocimiento' desde Aprobar selección:", error)
    );
    resumen.push("🧠 Guardar como conocimiento — en curso.");
  }

  const colaTexto = ["corregir", "ajustarmonto", "otrasacciones"].filter((k) => necesitaTexto(k) && seleccion.includes(k));
  const decisionFinal = seleccion.find((k) => esAccionFinal(k));

  if (colaTexto.length > 0) {
    await guardarPendienteSeleccionGasto(propuesta.chatId, propuesta.id, colaTexto, decisionFinal);
    const restantes = colaTexto.slice(1).map((k) => etiquetaAccion(k));
    await sendTelegramMessage(
      propuesta.chatId,
      [
        ...resumen,
        `Marcaste ${colaTexto.map((k) => etiquetaAccion(k)).join(", ")}${decisionFinal ? ` y "${etiquetaAccion(decisionFinal)}"` : ""} — voy preguntando de a una, en orden.`,
        preguntaParaAccion(colaTexto[0], propuesta),
        restantes.length > 0 ? `(Después te pregunto lo que falte para: ${restantes.join(", ")}.)` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return;
  }

  if (resumen.length > 0) {
    await sendTelegramMessage(propuesta.chatId, resumen.join("\n"));
  }

  if (decisionFinal) {
    // dispararDecisionFinal ya reemplaza el texto Y los botones del mensaje
    // original con el resultado final (vía consumirPropuestaGasto/editTelegramMessage
    // en gasto_nuevo/gasto_cancelar/etc.) — nunca hay que reponer el teclado acá.
    await dispararDecisionFinal(propuesta, decisionFinal);
    return;
  }

  // Nada quedó pendiente (ni cola de texto, ni decisión final) — la propuesta
  // sigue viva para que Carlos pueda marcar más acciones después (ej. decidir
  // "Crear" más tarde), así que se repone el teclado interactivo, ya sin
  // ningún check marcado.
  const propuestaFresca = await obtenerPropuestaGasto(propuesta.id);
  if (propuestaFresca) {
    const teclado = construirTecladoGasto(propuestaFresca, opcionesTecladoDesdePropuesta(propuestaFresca));
    await editTelegramMessageReplyMarkup(propuestaFresca.chatId, propuestaFresca.messageId, teclado).catch((error) =>
      console.error("[gastoCallbackHandler] Error reponiendo el teclado tras aplicar (no crítico):", error)
    );
  }
}

/**
 * Continúa la cola secuencial de texto libre tras "▶️ Aprobar selección"
 * (ver handleGastoAprobarCallback) — aplica UNA acción por mensaje, nunca
 * intenta repartir un solo texto entre varias preguntas distintas. Al
 * vaciarse la cola, dispara la decisión final marcada (si había una), ya
 * con las correcciones/ajustes aplicados.
 */
export async function continuarConSeleccionGasto(pendiente: PendienteSeleccionGasto, textoUsuario: string): Promise<void> {
  const propuesta = await obtenerPropuestaGasto(pendiente.propuestaId);
  if (!propuesta) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible.");
    return;
  }

  const [actual, ...resto] = pendiente.colaAcciones;
  if (!actual) return;

  const resultado =
    actual === "corregir"
      ? await aplicarTextoCorreccion(propuesta, textoUsuario)
      : actual === "ajustarmonto"
        ? await aplicarTextoAjusteMonto(propuesta, textoUsuario)
        : await aplicarTextoOtrasAcciones(propuesta, textoUsuario);

  if (!resultado.ok && resultado.reintentable) {
    await guardarPendienteSeleccionGasto(pendiente.chatId, pendiente.propuestaId, pendiente.colaAcciones, pendiente.decisionFinal);
    await sendTelegramMessage(pendiente.chatId, resultado.mensaje);
    return;
  }

  await sendTelegramMessage(pendiente.chatId, resultado.mensaje);

  if (!resultado.ok) {
    // No reintentable (ej. la propuesta ya no existe) — no tiene sentido
    // seguir pidiendo el resto de la cola ni disparar la decisión final.
    return;
  }

  if (resto.length > 0) {
    await guardarPendienteSeleccionGasto(pendiente.chatId, pendiente.propuestaId, resto, pendiente.decisionFinal);
    const propuestaFresca = (await obtenerPropuestaGasto(pendiente.propuestaId)) ?? propuesta;
    await sendTelegramMessage(pendiente.chatId, preguntaParaAccion(resto[0], propuestaFresca));
    return;
  }

  if (!pendiente.decisionFinal) {
    // Nada de decisión final — la propuesta original sigue viva (su teclado
    // quedó vacío desde "Aprobar selección", ver handleGastoAprobarCallback).
    // Caso real (2026-09-07): reponer el teclado en el mensaje ORIGINAL (ya
    // arriba en el chat, detrás de "🔄 Aplicando tu selección...", la
    // pregunta del ajuste, y esta misma respuesta) lo dejaba fuera de vista
    // — Carlos no vio que los botones habían vuelto y terminó escribiendo
    // "sí, créalo y concilia" en texto libre, que el asistente conversacional
    // no tenía forma de completar (esa escritura SIEMPRE requiere un botón
    // real, nunca se dispara por interpretación de texto — ver
    // conciliarMovimiento.ts). Ahora se manda un mensaje NUEVO, visible al
    // final del chat, con los mismos botones reales — y se repunta la
    // propuesta a ESE mensaje (actualizarMessageIdGasto) para que tocarlos
    // edite el mensaje correcto.
    const propuestaFinal = await obtenerPropuestaGasto(pendiente.propuestaId);
    if (propuestaFinal) {
      const teclado = construirTecladoGasto(propuestaFinal, opcionesTecladoDesdePropuesta(propuestaFinal));
      const messageId = await sendTelegramMessageWithButtons(
        propuestaFinal.chatId,
        `✅ Listo — apliqué todo lo que marcaste. "${propuestaFinal.proveedor}" (${propuestaFinal.monto.toFixed(2)} ${propuestaFinal.moneda}) sigue esperando tu decisión — toca una opción:`,
        teclado
      ).catch((error) => {
        console.error("[gastoCallbackHandler] Error reenviando el teclado tras la cola de selección:", error);
        return undefined;
      });
      if (messageId !== undefined) {
        await actualizarMessageIdGasto(propuestaFinal.id, messageId).catch((error) =>
          console.error("[gastoCallbackHandler] Error actualizando el messageId tras reenviar el teclado (no crítico):", error)
        );
      } else {
        // Hallazgo real de auditoría: si el reenvío con botones falla (ej. caída transitoria de
        // Telegram), esto se quedaba en silencio total — exactamente el mismo síntoma ("no veo nada
        // para aprobar") que este mismo cambio existe para eliminar, solo que disparado por otro
        // punto de fallo. Un aviso en texto plano, aunque sin botones, es mejor que nada.
        await sendTelegramMessage(
          propuestaFinal.chatId,
          `✅ Apliqué todo lo que marcaste, pero no pude reenviar los botones de "${propuestaFinal.proveedor}" (${propuestaFinal.monto.toFixed(2)} ${propuestaFinal.moneda}) — probablemente un fallo transitorio de Telegram. Dímelo en texto libre (ej. "créalo y concilia") y lo reintento.`
        ).catch(() => {});
      }
    } else {
      await sendTelegramMessage(pendiente.chatId, "✅ Listo — apliqué todo lo que marcaste.");
    }
    return;
  }

  const propuestaFresca = await obtenerPropuestaGasto(pendiente.propuestaId);
  if (!propuestaFresca) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible para la decisión final que habías marcado.");
    return;
  }
  await dispararDecisionFinal(propuestaFresca, pendiente.decisionFinal);
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
  /**
   * true cuando conciliarInline=true y la búsqueda encontró varios movimientos parecidos —
   * intentarConciliar ya mandó aparte los botones "🔗 Conciliar con #N" (ver
   * ofrecerEleccionMovimientosAmbiguos) y el llamador debe esperar esa respuesta antes de avanzar la
   * cola de correo, igual que con conciliacionPendiente.
   */
  esperandoEleccionConciliacion?: boolean;
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
/**
 * Texto compartido por los 3 llamadores de crearGastoYReportar para cuando
 * lanza PosibleDuplicadoGastoError — nunca dice "puedes reenviarlo" tal cual
 * (el mensaje genérico de error de más abajo) porque eso invitaría a repetir
 * justo la acción que causó el duplicado que se acaba de evitar. Hallazgo
 * real de auditoría: la versión anterior decía "dímelo explícitamente para
 * que lo cree de todas formas" — pero no hay ninguna herramienta conectada
 * que reconozca esa frase y fuerce la creación; era una promesa vacía. El
 * camino real que SÍ funciona: volver a mandar/reenviar el documento
 * original hace que procesarGastoEntrante arme una propuesta NUEVA, cuyos
 * candidatos ya van a incluir esta compra (porque ahora sí existe en
 * Holded) — con eso, el botón normal "🆕 Crear gasto nuevo" (que ya ofrece
 * candidatos.length > 0) queda disponible sin volver a bloquearse.
 */
export function mensajeDuplicadoDetectado(candidatos: PosibleDuplicadoGastoError["candidatos"]): string {
  const listado = formatearCandidatosDuplicado(candidatos);
  return (
    `⛔ No creé el gasto — encontré en Holded ${candidatos.length === 1 ? "una compra" : candidatos.length + " compras"} que podría(n) ` +
    `ser este mismo, y que no te había mostrado antes:\n${listado}\n\n` +
    `Si es el mismo, descarta esta propuesta — no hace falta hacer nada más. Si de verdad es un gasto NUEVO y distinto (no el mismo importe ` +
    `repetido), vuelve a mandarme el documento/correo original — te armo una propuesta nueva que ya tiene en cuenta esta compra y te deja elegir ` +
    `"🆕 Crear gasto nuevo" sin que se vuelva a bloquear.`
  );
}

/** Mismo criterio de mensaje que mensajeDuplicadoDetectado, pero para cuando la verificación misma falló (ver VerificacionDuplicadoFallidaError) — nunca decir "puedes reenviarlo" acá tampoco, ya que Holded pudo haber creado el gasto o no según dónde falló exactamente. */
function mensajeVerificacionDuplicadoFallida(error: VerificacionDuplicadoFallidaError): string {
  return (
    `⚠️ No pude confirmar que este gasto no esté ya duplicado en Holded (${error.message}) — por seguridad, NO lo creé. ` +
    `Revisa en Holded a mano si ya existe, y si Holded parece estar bien, vuelve a intentar en un momento.`
  );
}

async function crearGastoYReportar(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"],
  conceptoFinal: string,
  contactoForzado?: { id: string; name: string },
  conciliarInline: boolean = false,
  aprenderAlias: boolean = true,
  /**
   * Movimiento bancario ESPECÍFICO ya elegido por Carlos (ver PropuestaGasto.movimientosAmbiguos /
   * gastoTeclado.ts "🔗 Conciliar con #N") — cuando se da, se concilia DIRECTO contra ese movimiento
   * (mismo id de cuenta/movimiento), sin volver a buscar. Sin esto, conciliarInline volvería a
   * buscar en genérico (intentarConciliar) y toparía con la MISMA ambigüedad que ya se resolvió.
   */
  movimientoObjetivo?: MovimientoBancarioCandidato
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

  // Pedido explícito de Carlos, tras un caso real: una factura de alquiler
  // con retención de IRPF se registró en Holded sin la retención — el
  // gasto quedó con un total que no coincidía con el de la factura real
  // (ni con lo que de verdad salió del banco), y el chat lo reportó como
  // "conciliado" sin avisar del descuadre. Se calcula acá el total que
  // debería dar Holded a partir de las mismas líneas que se le mandan
  // (base + IVA - retención de cada una) y se compara contra el total real
  // de la propuesta — si no coincide, se avisa explícitamente en vez de
  // reportar éxito sin más, para que se pueda corregir a mano en Holded.
  const totalCalculado = lineas.reduce(
    (acc, l) => acc + l.base * (1 + l.tipoIvaPct / 100 - (l.retencionPct ?? 0) / 100),
    0
  );
  const notaDescuadre =
    Math.abs(totalCalculado - propuesta.monto) > 0.05
      ? `\n\n⚠️ El total que va a quedar registrado en Holded (${totalCalculado.toFixed(2)} ${propuesta.moneda}, según las líneas) ` +
        `NO coincide con el total real de la factura (${propuesta.monto.toFixed(2)} ${propuesta.moneda}) — revísalo y corrígelo a mano en Holded ` +
        `(puede ser una retención de IRPF u otro descuento que no se haya interpretado bien).`
      : "";

  // Pedido explícito de Carlos, tras un caso real: un billete de tren OUIGO
  // se registró con la cuenta contable por defecto de Holded ("Compras de
  // mercaderías") en vez de algo relacionado con viajes — inferirCuentaGasto
  // (core/holded/write.ts) SOLO puede sugerir una cuenta que YA esté en uso
  // real en otra compra parecida (Holded no expone su plan de cuentas
  // completo por API, así que nunca puede inventar un id) — cuando no
  // encuentra ninguna coincidencia razonable (ej. el primer gasto de este
  // tipo para esta empresa), deja que Holded use su cuenta genérica en
  // silencio. Ahora se avisa explícitamente en vez de dejarlo pasar sin
  // decir nada — "buscar en Holded o preguntar": ya se buscó y no había
  // nada parecido, así que toca preguntar/corregir a mano.
  const notaCuentaSinInferir = !propuesta.cuentaId
    ? `\n\n⚠️ No encontré ninguna compra parecida ya registrada para elegir la cuenta contable — Holded lo dejó en su ` +
      `cuenta genérica por defecto. Revisa y corrige la "Cuenta contable" a mano en Holded si no es la correcta ` +
      `(la próxima vez que aparezca algo parecido, ya la usaré directo).`
    : "";

  // Pedido explícito de Carlos, tras un caso real (recibo de Uber sin
  // ningún folio/número visible): "recuerda que si no lo identificas en el
  // anexo lo rellenas con 00000" — crearGastoHolded ya rellena el campo
  // con ese placeholder cuando no hay número real, pero nunca en silencio:
  // se avisa acá para que quede claro que es un relleno, no un número real
  // leído del documento.
  const notaNumeroDocumento = !propuesta.numeroDocumento
    ? `\n\n📄 No identifiqué un número de documento en el comprobante — quedó como "00000" en Holded. Corrígelo a mano si el documento sí trae uno.`
    : "";

  // Pedido explícito de Carlos, tras un caso real (Booking.com — Hospedaje
  // Hotel Plaza Diana, Footprint, 204,65€): un gasto ya creado y ya
  // conciliado se volvió a crear como duplicado sin ninguna advertencia.
  // buscarGastoSimilar ya corrió una vez al procesar el correo original
  // (procesarGastoEntrante.ts), pero la propuesta puede quedar pendiente de
  // aprobación hasta 7 días (TTL_MS real de crearPropuestaGasto — el "hasta
  // 24h" de una versión anterior de este comentario subestimaba la ventana
  // real) — se vuelve a comprobar acá, justo antes de escribir en Holded,
  // contra el estado REAL más actual, no el que había cuando se armó la
  // propuesta. Solo bloquea si aparece un candidato NUEVO que Carlos no vio
  // ya en la propuesta original (ver PosibleDuplicadoGastoError) — así que
  // aprobar "🆕 Crear gasto nuevo" con candidatos ya mostrados y descartados
  // nunca vuelve a bloquearse por la misma decisión que ya tomó.
  //
  // Todo el bloque (verificar + crear) va dentro de conMutex, con la MISMA
  // clave para cualquier gasto del mismo proveedor+monto+empresa — hallazgo
  // real de auditoría: sin esto, dos aprobaciones casi simultáneas del mismo
  // gasto (dos propuestas para el mismo correo reenviado, o un doble-tap del
  // botón) podían pasar AMBAS la verificación antes de que cualquiera de las
  // dos terminara de escribir en Holded — el mismo tipo de carrera
  // verificar-y-luego-actuar que conMutex ya cierra para las escrituras de
  // Sheets en esta misma sesión, aplicado acá por el mismo motivo.
  //
  // La verificación en sí ahora falla CERRADO: si buscarGastoSimilar mismo
  // da error (Holded caído, rate limit), NUNCA se crea el gasto a ciegas —
  // se avisa explícito y hay que reintentar. Antes fallaba abierto (creaba
  // igual), justo el "pasar en silencio" que este fix existe para eliminar.
  const claveMutexDuplicado = `${empresaFinal}:${propuesta.proveedor.trim().toLowerCase()}:${propuesta.monto.toFixed(2)}`;
  const fechaBusqueda = propuesta.fecha || new Date().toISOString().slice(0, 10);

  const gasto = await conMutex(claveMutexDuplicado, async () => {
    let candidatosJustoAntes: PurchaseCandidato[];
    try {
      candidatosJustoAntes = await buscarGastoSimilar(empresaFinal, {
        proveedor: propuesta.proveedor,
        monto: propuesta.monto,
        fecha: fechaBusqueda,
      });
    } catch (error) {
      throw new VerificacionDuplicadoFallidaError(error);
    }
    const idsYaVistos = new Set(propuesta.candidatos.map((c) => c.id));
    const candidatosNuevos = candidatosJustoAntes.filter((c) => !idsYaVistos.has(c.id));
    if (candidatosNuevos.length > 0) {
      throw new PosibleDuplicadoGastoError(candidatosNuevos);
    }

    return crearGastoHolded(empresaFinal, {
      contactId: contacto.id,
      fecha: fechaBusqueda,
      descripcion: descripcionFinal,
      lineas,
      cuentaId: propuesta.cuentaId,
      tags: propuesta.cuentaTags,
      moneda: propuesta.moneda,
      numeroDocumento: propuesta.numeroDocumento,
    });
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

  // Pedido explícito de Carlos ("que la práctica te vaya dando experticia"):
  // propuesta.cuentaId, cuando viene dado, siempre viene de inferirCuentaGasto
  // (nunca hay hoy un camino donde el usuario la fuerce explícita antes de
  // crear) — se registra para que revisarCorreccionesCuentaContable.ts
  // pueda detectar más adelante si Carlos la corrigió a mano en Holded.
  //
  // Hallazgo real de auditoría xhigh: inferirCuentaGasto se llamó para
  // `propuesta.empresa` (la empresa detectada originalmente, en
  // procesarGastoEntrante.ts) — si Carlos corrige la clasificación a OTRA
  // empresa (ej. "EWORKS, servicio de limpieza" vía "✏️ Corregir
  // clasificación", ver parsearCorreccionClasificacion), `empresaFinal`
  // difiere de `propuesta.empresa` y propuesta.cuentaId queda siendo la
  // cuenta de un plan de cuentas AJENO — no tiene sentido en la empresa
  // real donde se está creando el gasto. Registrar esa asignación de todas
  // formas contaminaría cuentaCorregidaAprendidaSheet.ts la semana
  // siguiente: si Holded ignora en silencio ese id ajeno y el gasto cae en
  // la cuenta genérica por defecto, revisarCorreccionesCuentaContable.ts lo
  // vería como "Carlos corrigió a la cuenta genérica" y el tier 0 aplicaría
  // esa cuenta genérica con máxima confianza a este proveedor en la empresa
  // correcta desde entonces — exactamente el tipo de mala categorización
  // que este sistema de aprendizaje existe para evitar. Solo se registra
  // cuando la cuenta sugerida de verdad corresponde a la empresa final.
  //
  // Hallazgo real de auditoría xhigh (efficiency): estas 3 escrituras de
  // aprendizaje son independientes entre sí (tablas distintas) y cada una ya
  // se protege con su propio .catch "no crítico" — no hay ninguna razón para
  // esperarlas una tras otra antes de responder a Carlos. Promise.all las
  // corre en paralelo (nunca puede rechazar, cada promesa ya se atrapa a sí
  // misma) — el tiempo total pasa de la SUMA de las 3 escrituras a Sheets al
  // MÁXIMO de las 3.
  await Promise.all([
    registrarClasificacionAprendida(propuesta.proveedor, empresaFinal, conceptoFinal || propuesta.concepto).catch(
      (error) => console.error("[gastoCallbackHandler] No se pudo guardar la clasificación aprendida (no crítico):", error)
    ),
    // Hallazgo real de auditoría (caso Avianca/Larrauri, 2026-09-10): registro directo de "este correo
    // ya se convirtió en este gasto" — ver gastoPorCorreoStore.ts para el bug real que esto cierra
    // (el mismo correo reprocesado generaba una propuesta duplicada, a veces sin que buscarGastoSimilar
    // la atrapara a tiempo por depender de la propia búsqueda de Holded). No crítico: si esto falla, la
    // protección normal de duplicados (buscarGastoSimilar) sigue siendo la primera línea de defensa.
    propuesta.correoOrigen?.mensajeIdGmail
      ? registrarGastoDesdeCorreo({
          mensajeIdGmail: propuesta.correoOrigen.mensajeIdGmail,
          // Distingue CUÁL adjunto de un correo con varios ya se resolvió — ver el comentario de
          // gastoPorCorreoStore.ts sobre por qué esto no puede ser solo por mensajeIdGmail.
          attachmentId: propuesta.origenAdjuntoGmail?.attachmentIdGmail,
          gastoId: gasto.id,
          empresa: empresaFinal,
        }).catch((error) => console.error("[gastoCallbackHandler] No se pudo registrar el gasto por correo (no crítico):", error))
      : Promise.resolve(),
    contactoForzado && aprenderAlias
      ? registrarAliasProveedor(empresaFinal, propuesta.proveedor, contactoForzado.id, contactoForzado.name).catch(
          (error) => console.error("[gastoCallbackHandler] No se pudo guardar el alias de proveedor (no crítico):", error)
        )
      : Promise.resolve(),
    propuesta.cuentaId && empresaFinal === propuesta.empresa
      ? registrarAsignacionCuenta({ gastoId: gasto.id, empresa: empresaFinal, proveedor: propuesta.proveedor, cuentaIdAsignada: propuesta.cuentaId }).catch(
          (error) => console.error("[gastoCallbackHandler] No se pudo registrar la asignación de cuenta (no crítico):", error)
        )
      : Promise.resolve(),
  ]);

  const nombreContacto = contacto.name ?? propuesta.proveedor;
  // Bug real encontrado en vivo (2026-09-07): el mismo contacto placeholder ("PROVEEDOR SIN
  // IDENTIFICAR") se reutiliza en TODOS los gastos sin proveedor identificado de una empresa — Carlos,
  // al querer corregir el proveedor de UN gasto puntual desde Holded, renombró este contacto compartido
  // directamente (dos veces seguidas: a "Aeropuerto de panama" primero, luego a "Kyriad Creteil") en vez
  // de crear un contacto nuevo y separado — sin darse cuenta, eso cambió el nombre mostrado en TODOS los
  // demás gastos (pasados y futuros) que usan el mismo placeholder, generando confusión real ("¿por qué
  // dice Aeropuerto de Panamá si esto es un hotel en Francia?"). El aviso original ("corrige el contacto
  // a mano en Holded") no dejaba claro que renombrarlo ahí lo afecta a TODOS — ahora se dice explícito.
  const notaPlaceholder =
    !aprenderAlias && contactoForzado
      ? `\n\n⚠️ Se usó el contacto genérico "${nombreContacto}" porque "${propuesta.proveedor}" no está en Holded — ` +
        `el nombre real quedó en la descripción del gasto, nunca se pierde. Para corregirlo: NUNCA renombres este ` +
        `contacto genérico directamente en Holded — es el MISMO contacto compartido por todos los gastos sin ` +
        `proveedor identificado, así que renombrarlo cambia el nombre mostrado en todos los demás (pasados y ` +
        `futuros), no solo en este. En su lugar, crea un contacto NUEVO y separado con el nombre real del ` +
        `proveedor en Holded, y avísame por chat para reasignar SOLO este gasto a ese contacto nuevo.`
      : "";
  const baseMensaje =
    `✅ Gasto creado en Holded (id ${gasto.id}, contacto ${nombreContacto}, como borrador)` +
    (notaComprobante ? "." : " y comprobante adjuntado.") +
    notaComprobante +
    notaPlaceholder +
    notaDescuadre +
    notaCuentaSinInferir +
    notaNumeroDocumento;

  if (conciliarInline) {
    if (movimientoObjetivo) {
      // Hallazgo real de auditoría xhigh: esta es la MISMA clase de ambigüedad
      // real que gasto_conciliar_elegir aprende de (movimientoObjetivo viene
      // de PropuestaGasto.movimientosAmbiguos, resuelta por Carlos vía el
      // teclado "🔗 Conciliar con #N" ANTES de crear el gasto) — faltaba
      // pasar propuesta.proveedor acá, así que este camino (posiblemente el
      // más común, ya que resuelve la ambigüedad en el mismo tap que crea el
      // gasto) nunca alimentaba movimientoAmbiguoAprendidoSheet.ts.
      const notaConciliacion = await conciliarContraMovimientoEspecifico(empresaFinal, movimientoObjetivo, gasto.id, false, propuesta.proveedor);
      return { mensaje: `${baseMensaje}${notaConciliacion}` };
    }
    // propuesta.proveedor (el texto real leído de la factura/correo, ej.
    // "Uber"), NO nombreContacto — bug real encontrado en auditoría:
    // nombreContacto puede ser el contacto genérico "PROVEEDOR SIN
    // IDENTIFICAR" (cuando no se encontró en Holded), que nunca va a
    // aparecer en la descripción de ningún movimiento bancario real, así
    // que la búsqueda aproximada nunca encontraba nada aunque el nombre
    // real (que sí se conocía) hubiera hecho match.
    const { nota: notaConciliacion, esperandoEleccion } = await intentarConciliar(
      empresaFinal,
      propuesta.monto,
      propuesta.fecha,
      gasto.id,
      propuesta.chatId,
      `${nombreContacto} — ${propuesta.monto} ${propuesta.moneda}`,
      propuesta.moneda,
      propuesta.proveedor,
      propuesta.deColaCorreo === true
    );
    return { mensaje: `${baseMensaje}${notaConciliacion}`, esperandoEleccionConciliacion: esperandoEleccion };
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
        resolucion.propuesta.deColaCorreo === true,
        resolucion.propuesta.correoOrigen?.mensajeIdGmail
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
    if (error instanceof PosibleDuplicadoGastoError) {
      await editTelegramMessage(resolucion.chatId, resolucion.messageId, mensajeDuplicadoDetectado(error.candidatos), []);
      return;
    }
    if (error instanceof VerificacionDuplicadoFallidaError) {
      await editTelegramMessage(resolucion.chatId, resolucion.messageId, mensajeVerificacionDuplicadoFallida(error), []);
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
 * Interpreta "empresa, concepto" de texto libre — usado tanto por la
 * corrección clásica (continuarConCorreccionGasto, que crea el gasto de
 * inmediato) como por la nueva "Corregir clasificación" del teclado de
 * selección (aplicarTextoCorreccion, que solo actualiza campos). Bug real
 * encontrado al extraer esta función a un solo lugar: el chequeo original
 * solo reconocía "WOBA"/"EWORKS" — escribir "Footprint, concepto..." se
 * ignoraba en silencio y la empresa quedaba sin corregir, sin ningún aviso.
 */
function parsearCorreccionClasificacion(
  texto: string,
  empresaActual: PropuestaGasto["empresa"]
): { empresa: PropuestaGasto["empresa"]; concepto: string } {
  const [empresaRaw, ...resto] = texto.split(",");
  const empresaTexto = empresaRaw.trim().toUpperCase();
  const empresa: PropuestaGasto["empresa"] =
    empresaTexto === "WOBA"
      ? "WOBA"
      : empresaTexto === "EWORKS"
        ? "EWORKS"
        : empresaTexto === "FOOTPRINT"
          ? "Footprint"
          : empresaActual;
  const concepto = resto.join(",").trim() || texto.trim();
  return { empresa, concepto };
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

  const { empresa: empresaFinal, concepto: conceptoFinal } = parsearCorreccionClasificacion(textoUsuario, propuesta.empresa);

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
        propuesta.deColaCorreo === true,
        propuesta.correoOrigen?.mensajeIdGmail
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
    if (error instanceof PosibleDuplicadoGastoError) {
      await sendTelegramMessage(propuesta.chatId, mensajeDuplicadoDetectado(error.candidatos));
      return;
    }
    if (error instanceof VerificacionDuplicadoFallidaError) {
      await sendTelegramMessage(propuesta.chatId, mensajeVerificacionDuplicadoFallida(error));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error procesando corrección de gasto:", message);
    await sendTelegramMessage(pendiente.chatId, `⚠️ Error: ${message}\n\nEl archivo local no se borró — puedes reenviarlo.`);
    // No avanza la cola en el error — mismo criterio que arriba.
  }
}

/**
 * Convierte un número escrito en texto libre (formato ES "1.234,56" o
 * normal "1234.56"/"251.30") a un valor real — si trae los dos separadores,
 * el que aparece AL FINAL es el decimal de verdad (el otro es de miles).
 * undefined si el texto no es un número reconocible — nunca adivina.
 */
function parsearNumeroLibre(texto: string): number | undefined {
  const limpio = texto.trim();
  if (!/^-?[\d.,]+$/.test(limpio)) return undefined;

  const tieneComa = limpio.includes(",");
  const tienePunto = limpio.includes(".");

  let normalizado: string;
  if (tieneComa && tienePunto) {
    normalizado =
      limpio.lastIndexOf(",") > limpio.lastIndexOf(".")
        ? limpio.replace(/\./g, "").replace(",", ".")
        : limpio.replace(/,/g, "");
  } else if (tieneComa) {
    // Bug real encontrado en auditoría: con MÁS de una coma (ej. "1,234,567",
    // agrupación de miles al estilo US sin decimales) reemplazar solo la
    // PRIMERA coma dejaba una coma suelta que rompía el parseo — un número
    // válido se rechazaba como si no lo fuera. Con una sola coma, es
    // decimal (criterio ES); con varias, son separadores de miles.
    const comas = (limpio.match(/,/g) ?? []).length;
    normalizado = comas === 1 ? limpio.replace(",", ".") : limpio.replace(/,/g, "");
  } else {
    normalizado = limpio;
  }

  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : undefined;
}

/**
 * Interpreta la respuesta a "💰 Ajustar monto" (ver handleGastoCallback) —
 * NUNCA calcula un monto por su cuenta a partir de suposiciones: solo
 * entiende una fracción explícita ("la mitad", "50%") aplicada al monto
 * ORIGINAL de la propuesta, o un monto nuevo escrito literal. Si el texto
 * no encaja en ninguno de los dos, no adivina — vuelve a preguntar.
 */
function interpretarNuevoMonto(texto: string, montoOriginal: number): number | undefined {
  const limpio = texto.trim().toLowerCase();

  // Bug real encontrado en auditoría: sin el guard de montoOriginal > 0,
  // una propuesta degenerada (monto 0 o negativo) podía devolver 0/negativo
  // como "nuevo monto" sin que interpretarNuevoMonto lo rechazara — a
  // diferencia del camino de número literal, que sí exige > 0. El "50%"
  // literal se quitó (redundante — el regex de porcentaje de abajo ya lo
  // cubre exactamente igual).
  if (/^(la\s+)?mitad$/.test(limpio)) return montoOriginal > 0 ? montoOriginal / 2 : undefined;

  const porcentaje = limpio.match(/^(\d+([.,]\d+)?)\s*%$/);
  if (porcentaje) {
    const pct = parsearNumeroLibre(porcentaje[1]);
    return pct !== undefined && pct > 0 && montoOriginal > 0 ? montoOriginal * (pct / 100) : undefined;
  }

  // Un número literal se toma como el monto NUEVO absoluto, no como
  // fracción del original.
  const numero = parsearNumeroLibre(limpio);
  return numero !== undefined && numero > 0 ? numero : undefined;
}

interface ResultadoAplicarTexto {
  ok: boolean;
  /** Solo cuando ok=false: si true, la MISMA pregunta se puede repetir (texto no entendido); si false, no tiene sentido reintentar (ej. la propuesta ya no existe). */
  reintentable?: boolean;
  mensaje: string;
}

// Bug real encontrado en auditoría: con propuesta.monto <= 0, un factor de
// reserva de "1" dejaba las líneas SIN escalar (base ~0) mientras la
// columna monto sí se sobrescribía al nuevo valor — Holded crea el gasto
// a partir de las líneas, no de monto, así que el gasto real habría
// quedado en 0€ aunque Telegram reportara el monto correcto. Si no hay
// línea previa con base real, se reemplaza todo por una línea limpia.
function reescalarLineas(propuesta: PropuestaGasto, nuevoMonto: number): LineaFactura[] {
  return propuesta.monto > 0 && propuesta.lineas.length > 0
    ? propuesta.lineas.map((l) => ({ ...l, base: (l.base * nuevoMonto) / propuesta.monto }))
    : [{ concepto: propuesta.concepto, base: nuevoMonto, tipoIvaPct: 0 }];
}

async function aplicarNuevoMonto(propuesta: PropuestaGasto, nuevoMonto: number): Promise<ResultadoAplicarTexto> {
  const actualizado = await actualizarMontoPropuestaGasto(propuesta.id, nuevoMonto, reescalarLineas(propuesta, nuevoMonto));
  if (!actualizado) {
    return { ok: false, reintentable: false, mensaje: "Esa propuesta ya no está disponible." };
  }

  return {
    ok: true,
    mensaje: `💰 Monto ajustado — ${propuesta.proveedor}: ${propuesta.monto.toFixed(2)} ${propuesta.moneda} → ${nuevoMonto.toFixed(2)} ${propuesta.moneda}.`,
  };
}

/**
 * Pedido explícito de Carlos, tras un caso real: el correo de Kelly reportó un gasto de Uber Eats
 * como "$12.71" pero el cargo real había sido en euros — el NÚMERO estaba bien, la MONEDA no. Tras
 * corregir moneda/monto, vuelve a buscar un movimiento bancario real en la moneda ya corregida (antes
 * no se encontraba nada porque se buscaba en la moneda equivocada) — exacto y luego aproximado, mismo
 * criterio que procesarGastoEntrante.ts — y, si el resultado cambia, refresca los botones del mensaje
 * original para que "Crear y conciliar" aparezca si ahora corresponde. Solo distingue "Crear y
 * conciliar" con confianza cuando hay UN match, nunca con varios ambiguos — mismo criterio que
 * procesarGastoEntrante.ts (candidatosMovAmbiguos), hallazgo real de auditoría: un único match
 * verdadero no es lo mismo que "encontré algo", y ofrecer el botón con varios candidatos posibles
 * prometería una conciliación que después se rechaza sola al intentarla.
 *
 * Si la propuesta ya tenía candidatos de Holded (documento ya cargado que podría corresponder,
 * encontrados con el monto/moneda ANTERIOR), esos candidatos no se vuelven a buscar acá — hallazgo
 * real de auditoría: buscarGastoSimilar no filtra por moneda (compara solo el número), así que
 * mientras el NÚMERO no cambie los candidatos siguen siendo válidos; si sí cambia, se avisa
 * explícitamente que conviene revisarlos de nuevo en vez de fingir que ya se hizo.
 */
async function aplicarCorreccionMoneda(propuesta: PropuestaGasto, monedaCorrecta: string, montoFinal: number): Promise<ResultadoAplicarTexto> {
  // Hallazgo real de auditoría: a diferencia de la detección original (procesarGastoEntrante.ts,
  // que valida contra monedasReales antes de aceptar una moneda), esta corrección por IA no tenía
  // ninguna validación — un código de moneda mal inferido por el modelo se escribía directo. Mismo
  // criterio de respaldo que procesarGastoEntrante.ts: si la consulta falla, asume solo EUR en vez
  // de saltarse la validación.
  const monedasReales = await obtenerMonedasCuentasReales(propuesta.empresa).catch((error) => {
    console.error("[gastoCallbackHandler] Error consultando monedas reales de la empresa (asume solo EUR):", error);
    return new Set(["EUR"]);
  });
  if (!monedasReales.has(monedaCorrecta)) {
    const monedasTxt = Array.from(monedasReales).sort().join(", ");
    return {
      ok: false,
      reintentable: true,
      mensaje:
        `Entendí que la moneda correcta sería ${monedaCorrecta}, pero ${propuesta.empresa} no tiene ninguna cuenta ` +
        `real en esa moneda (sí tiene: ${monedasTxt}) — ¿cuál es la moneda real? Dime el nombre o el código (ej. "euros").`,
    };
  }

  const cambioMonto = montoFinal !== propuesta.monto;
  const nuevasLineas = reescalarLineas(propuesta, montoFinal);
  const actualizado = await actualizarMonedaPropuestaGasto(propuesta.id, monedaCorrecta, montoFinal, nuevasLineas);
  if (!actualizado) {
    return { ok: false, reintentable: false, mensaje: "Esa propuesta ya no está disponible." };
  }

  let notaMovimiento = "";
  if (propuesta.candidatos.length === 0) {
    let movimientoEncontrado = false;
    let movimientosAmbiguosNuevos: MovimientoBancarioCandidato[] = [];
    try {
      const candidatosMov = await buscarMovimientoSimilar(propuesta.empresa, { monto: montoFinal, fecha: propuesta.fecha, moneda: monedaCorrecta });
      if (candidatosMov.length === 1) {
        movimientoEncontrado = true;
      } else if (candidatosMov.length > 1) {
        movimientosAmbiguosNuevos = candidatosMov;
      } else if (propuesta.proveedor) {
        const aproximados = await buscarMovimientoAproximado(propuesta.empresa, {
          monto: montoFinal,
          fecha: propuesta.fecha,
          moneda: monedaCorrecta,
          proveedor: propuesta.proveedor,
        });
        if (aproximados.length > 0) movimientoEncontrado = true;
      }
    } catch (error) {
      console.error("[gastoCallbackHandler] Error buscando movimiento tras corregir moneda (no crítico):", error);
    }

    // Hallazgo real de auditoría: hayMovimientoBancario y movimientosAmbiguos son mutuamente
    // excluyentes por diseño (ver gastoTeclado.ts) — sin actualizar AMBOS acá, una corrección de
    // moneda podía dejar movimientosAmbiguos VIEJO (de la moneda anterior) guardado mientras
    // hayMovimientoBancario pasaba a true, violando esa exclusión y sin ninguna forma de mostrar los
    // checks de un hallazgo ambiguo NUEVO en esta misma moneda corregida.
    await actualizarFlagMovimientoBancarioGasto(propuesta.id, movimientoEncontrado).catch((error) =>
      console.error("[gastoCallbackHandler] Error actualizando el flag de movimiento bancario (no crítico):", error)
    );
    await actualizarMovimientosAmbiguosPropuestaGasto(propuesta.id, movimientosAmbiguosNuevos).catch((error) =>
      console.error("[gastoCallbackHandler] Error actualizando los movimientos ambiguos (no crítico):", error)
    );
    try {
      const propuestaActualizada: PropuestaGasto = {
        ...propuesta,
        moneda: monedaCorrecta,
        monto: montoFinal,
        hayMovimientoBancario: movimientoEncontrado,
        movimientosAmbiguos: movimientosAmbiguosNuevos,
      };
      const botones = construirTecladoGasto(propuestaActualizada, opcionesTecladoDesdePropuesta(propuestaActualizada));
      await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, botones);
    } catch (error) {
      console.error("[gastoCallbackHandler] Error actualizando los botones tras corregir moneda (no crítico):", error);
    }

    notaMovimiento = movimientoEncontrado
      ? ` Ahora que la moneda es correcta, SÍ encontré un movimiento bancario real sin conciliar que coincide — usa "✅ Crear y conciliar" en el mensaje original.`
      : movimientosAmbiguosNuevos.length > 0
        ? ` Encontré ${movimientosAmbiguosNuevos.length} movimientos bancarios parecidos en ${monedaCorrecta} — marca "🔗 Conciliar con #N" en el mensaje original (ya actualizado) y aprueba tu selección.`
        : ` Seguí sin encontrar un movimiento bancario en ${monedaCorrecta} que coincida — revísalo a mano en Holded si ya salió del banco.`;
  } else if (cambioMonto) {
    notaMovimiento = ` Ojo: esta propuesta ya tenía candidatos de Holded encontrados con el monto anterior — revísalos de nuevo arriba, podrían ya no ser los correctos con el monto corregido.`;
  }

  return {
    ok: true,
    mensaje: `💱 Moneda corregida — ${propuesta.proveedor}: ${propuesta.monto.toFixed(2)} ${propuesta.moneda} → ${montoFinal.toFixed(2)} ${monedaCorrecta}.${notaMovimiento}`,
  };
}

/**
 * Núcleo de "💰 Ajustar monto", sin enviar ningún mensaje por sí solo —
 * usado tanto por el botón standalone (continuarConAjusteMonto, abajo) como
 * por la cola secuencial de "▶️ Aprobar selección" (continuarConSeleccionGasto).
 * El parser rápido/determinista (interpretarNuevoMonto) va primero — cubre los
 * casos comunes sin ningún costo de IA. Solo si no lo entiende, se intenta con
 * Claude (interpretarCorreccionGasto), que además de un monto nuevo puede
 * reconocer una corrección de MONEDA — pedido explícito de Carlos, tras un
 * caso real donde el parser rígido nunca entendió "12.71 Euros, en lugar de
 * dólares, la moneda estaba equivocada" como lo que era, y solo insistía en
 * pedir "un número".
 */
async function aplicarTextoAjusteMonto(propuesta: PropuestaGasto, textoUsuario: string): Promise<ResultadoAplicarTexto> {
  const nuevoMontoRapido = interpretarNuevoMonto(textoUsuario, propuesta.monto);
  if (nuevoMontoRapido !== undefined) {
    return aplicarNuevoMonto(propuesta, nuevoMontoRapido);
  }

  let correccion: CorreccionGasto;
  try {
    correccion = await interpretarCorreccionGasto({
      textoUsuario,
      montoOriginal: propuesta.monto,
      monedaOriginal: propuesta.moneda,
    });
  } catch (error) {
    console.error("[gastoCallbackHandler] Error interpretando corrección de gasto con IA (no crítico, se pide de nuevo):", error);
    correccion = { tipo: "no_entendido" };
  }

  if (correccion.tipo === "monto_nuevo") return aplicarNuevoMonto(propuesta, correccion.monto);
  if (correccion.tipo === "fraccion") {
    // Hallazgo real de auditoría: interpretarNuevoMonto (el parser rápido) exige montoOriginal > 0
    // antes de aplicar una fracción — esta misma protección faltaba acá, así que una propuesta
    // degenerada (monto <= 0) podía terminar con un monto 0/negativo escrito sin ningún aviso.
    if (propuesta.monto <= 0) {
      return {
        ok: false,
        reintentable: true,
        mensaje: `El monto actual de la propuesta no es válido (${propuesta.monto}) — no puedo calcular una fracción de eso. Dime el monto real como un número absoluto (ej. "251.30").`,
      };
    }
    return aplicarNuevoMonto(propuesta, propuesta.monto * correccion.fraccion);
  }
  if (correccion.tipo === "moneda_incorrecta") {
    return aplicarCorreccionMoneda(propuesta, correccion.monedaCorrecta, correccion.monto ?? propuesta.monto);
  }

  return {
    ok: false,
    reintentable: true,
    mensaje:
      `No entendí "${textoUsuario}" — dime un número (ej. "251.30"), "la mitad", o si la MONEDA era ` +
      `la equivocada (ej. "en realidad fue en euros, no dólares").`,
  };
}

export async function continuarConAjusteMonto(pendiente: PendienteAjusteMontoGasto, textoUsuario: string): Promise<void> {
  const propuesta = await obtenerPropuestaGasto(pendiente.propuestaId);
  if (!propuesta) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible.");
    return;
  }

  const resultado = await aplicarTextoAjusteMonto(propuesta, textoUsuario);
  if (!resultado.ok && resultado.reintentable) {
    // Se reinserta para poder reintentar — mismo criterio que
    // pendienteMontoStore.ts para errores de formato del texto.
    await guardarPendienteAjusteMontoGasto(pendiente.chatId, pendiente.propuestaId);
    await sendTelegramMessage(pendiente.chatId, resultado.mensaje);
    return;
  }

  await sendTelegramMessage(
    pendiente.chatId,
    resultado.ok
      ? `${resultado.mensaje} Los botones de la propuesta original arriba ya usan este monto — usa "✅ Crear gasto en Holded" ` +
        `cuando quieras, o "💰 Ajustar monto" de nuevo si hace falta corregirlo otra vez.`
      : resultado.mensaje
  );
}

/**
 * Continúa el flujo tras pulsar "✏️ Otras acciones" en una propuesta de
 * gasto que vino de un correo (ver gasto_otrasacciones arriba). Mismo
 * camino seguro que continuarConOrientacion (emailCallbackHandler.ts):
 * pasa por askClaude con su registro de tools ya existente (proponer envío
 * de correo, proponer evento/recordatorio...), nunca ejecuta nada fuera de
 * eso — así "responde el correo Y prográmame un recordatorio" en un solo
 * mensaje puede resolver las dos cosas en la misma llamada. A diferencia de
 * continuarConOrientacion, NUNCA llama avanzarColaCorreoSiActivo — esto es
 * una side-action sobre una propuesta de gasto todavía pendiente, no una
 * decisión que resuelva el correo activo de la cola (eso lo hace
 * gasto_nuevo/gasto_cancelar, que sí avanzan cuando deColaCorreo).
 */
/** Núcleo de "✏️ Otras acciones" — ver continuarConAccionGasto/continuarConSeleccionGasto (reutilizado por los dos). */
async function aplicarTextoOtrasAcciones(propuesta: PropuestaGasto, textoUsuario: string): Promise<ResultadoAplicarTexto> {
  if (!propuesta.correoOrigen) {
    return { ok: false, reintentable: false, mensaje: "Esa propuesta ya no está disponible." };
  }

  const instruccion =
    `El usuario dio instrucciones adicionales sobre un correo del que se detectó una factura/gasto. ` +
    `Correo — De: ${propuesta.correoOrigen.de}. Asunto: ${propuesta.correoOrigen.asunto}. ` +
    `Factura/gasto detectado: ${propuesta.proveedor}, ${propuesta.monto} ${propuesta.moneda}, ${propuesta.fecha}, ` +
    `concepto: ${propuesta.concepto} (el registro del gasto en Holded ya se maneja aparte, con sus propios botones — ` +
    `no hace falta que tú lo registres). Instrucción del usuario: ${textoUsuario}. Si es para responder el correo, ` +
    `usa el threadId "${propuesta.correoOrigen.threadId}" y el message_id_header "${propuesta.correoOrigen.messageIdHeader}" ` +
    `para que quede enhebrado como una respuesta real. Investiga y ejecuta lo que corresponda con las herramientas ` +
    `disponibles, y reporta el resultado.`;

  const respuesta = await askClaude(instruccion, propuesta.chatId, undefined, "accion_gasto");
  return { ok: true, mensaje: respuesta };
}

/**
 * Continúa el flujo tras pulsar "✏️ Otras acciones" en una propuesta de
 * gasto que vino de un correo (ver gasto_otrasacciones arriba). Mismo
 * camino seguro que continuarConOrientacion (emailCallbackHandler.ts):
 * pasa por askClaude con su registro de tools ya existente (proponer envío
 * de correo, proponer evento/recordatorio...), nunca ejecuta nada fuera de
 * eso — así "responde el correo Y prográmame un recordatorio" en un solo
 * mensaje puede resolver las dos cosas en la misma llamada. A diferencia de
 * continuarConOrientacion, NUNCA llama avanzarColaCorreoSiActivo — esto es
 * una side-action sobre una propuesta de gasto todavía pendiente, no una
 * decisión que resuelva el correo activo de la cola (eso lo hace
 * gasto_nuevo/gasto_cancelar, que sí avanzan cuando deColaCorreo).
 */
export async function continuarConAccionGasto(pendiente: PendienteAccionGasto, textoUsuario: string): Promise<void> {
  const propuesta = await obtenerPropuestaGasto(pendiente.propuestaId);
  if (!propuesta || !propuesta.correoOrigen) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible.");
    return;
  }

  await sendTelegramMessage(pendiente.chatId, "🔄 Procesando tu instrucción — esto puede tardar uno o dos minutos...").catch(
    (error) => console.error("[gastoCallbackHandler] No se pudo mostrar 'Procesando...' (no crítico):", error)
  );

  const resultado = await aplicarTextoOtrasAcciones(propuesta, textoUsuario);
  await sendTelegramMessageSmart(pendiente.chatId, resultado.mensaje, undefined, `✅ ${propuesta.correoOrigen.asunto} (${propuesta.correoOrigen.de})`);
}

/**
 * Núcleo de "✏️ Corregir clasificación" en su forma NO consumidora (teclado
 * de selección) — a diferencia de continuarConCorreccionGasto (el botón
 * standalone viejo, que crea el gasto de inmediato), esto SOLO actualiza
 * empresa/concepto y deja la propuesta viva.
 */
async function aplicarTextoCorreccion(propuesta: PropuestaGasto, textoUsuario: string): Promise<ResultadoAplicarTexto> {
  const { empresa, concepto } = parsearCorreccionClasificacion(textoUsuario, propuesta.empresa);
  const actualizado = await actualizarClasificacionPropuestaGasto(propuesta.id, empresa, concepto);
  if (!actualizado) {
    return { ok: false, reintentable: false, mensaje: "Esa propuesta ya no está disponible." };
  }
  return { ok: true, mensaje: `✏️ Clasificación corregida — empresa: ${empresa}, concepto: ${concepto}.` };
}

/**
 * "✉️ Responder correo" y "🧠 Guardar como conocimiento" extraídos a
 * funciones reutilizables — las usan tanto los botones standalone
 * (gasto_responder/gasto_guardarconocimiento) como "▶️ Aprobar selección"
 * (handleGastoAprobarCallback). Ninguna necesita texto del usuario, así que
 * se disparan de inmediato al aprobar, sin entrar en la cola secuencial.
 */
async function ejecutarResponderCorreo(propuesta: PropuestaGasto): Promise<void> {
  if (!propuesta.correoOrigen) return;
  const contexto =
    `Factura/gasto detectado en este correo: ${propuesta.proveedor}, ${propuesta.monto} ${propuesta.moneda}, ` +
    `${propuesta.fecha}, concepto: ${propuesta.concepto}.`;
  await generarBorradorYOfrecer(
    propuesta.chatId,
    propuesta.correoOrigen.de,
    propuesta.correoOrigen.asunto,
    propuesta.correoOrigen.threadId,
    propuesta.correoOrigen.messageIdHeader,
    contexto
  );
}

async function ejecutarGuardarConocimiento(propuesta: PropuestaGasto): Promise<void> {
  if (!propuesta.correoOrigen) return;
  try {
    const cuerpo = propuesta.correoOrigen.mensajeIdGmail
      ? await obtenerCuerpoCompletoCorreo(propuesta.correoOrigen.mensajeIdGmail)
      : "(no se pudo releer el cuerpo completo — sin id de mensaje de Gmail)";
    const contenido = [`De: ${propuesta.correoOrigen.de}`, `Asunto: ${propuesta.correoOrigen.asunto}`, "", cuerpo].join("\n");
    // false: esto es una side-action sobre una propuesta de gasto, no una
    // de las 4 decisiones de la cola de revisión de correo — el avance de
    // esa cola ya lo maneja la resolución del gasto en sí (deColaCorreo),
    // pasar true acá la avanzaría DOS veces.
    await iniciarSeleccionEmpresaCaptura(propuesta.chatId, contenido, propuesta.correoOrigen.de, undefined, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error preparando la captura del correo de un gasto:", message);
    await sendTelegramMessage(propuesta.chatId, `⚠️ No pude leer "${propuesta.correoOrigen.asunto}" para guardarlo como conocimiento.`);
  }
}
