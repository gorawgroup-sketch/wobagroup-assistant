import { unlink } from "node:fs/promises";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import type { InlineKeyboardButton } from "../telegram/types";
import { consumirPropuestaGasto, obtenerPropuestaGasto, type PropuestaGasto } from "./gastoProposalSheet";
import { guardarPendienteCorreccionGasto, type PendienteCorreccionGasto } from "./pendienteCorreccionGastoStore";
import { registrarClasificacionAprendida } from "./clasificacionAprendidaSheet";
import { registrarAliasProveedor } from "./proveedorAliasSheet";
import {
  guardarResolucionContacto,
  consumirResolucionContacto,
  type AlternativaContacto,
} from "./contactoResolucionStore";
import {
  buscarContactoHolded,
  buscarContactosParecidos,
  buscarComprasPorMonto,
  crearGastoHolded,
  adjuntarComprobanteHolded,
  buscarMovimientoSimilar,
  reconciliarMovimiento,
  ContactoNoEncontradoError,
  type HoldedContact,
} from "../holded/write";
import { obtenerRolUsuario } from "../telegram/authorizedUsersSheet";
import type { Empresa } from "../holded/client";
import type { TelegramCallbackQuery } from "../telegram/types";

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
async function intentarConciliar(empresa: Empresa, monto: number, fecha: string): Promise<string> {
  try {
    const fechaBusqueda = fecha || new Date().toISOString().slice(0, 10);
    const candidatos = await buscarMovimientoSimilar(empresa, { monto, fecha: fechaBusqueda });

    if (candidatos.length === 0) return "";
    if (candidatos.length > 1) {
      return `\n\n💳 Hay ${candidatos.length} movimientos bancarios sin conciliar parecidos — revísalo a mano en Holded.`;
    }

    const candidato = candidatos[0];
    const resultado = await reconciliarMovimiento(empresa, candidato.accountId, candidato.movementId, candidato.fecha);

    if (resultado.ok) {
      return `\n\n💳 Movimiento bancario conciliado automáticamente (${candidato.descripcion || "sin descripción"}, ${candidato.monto.toFixed(2)} €).`;
    }
    return (
      `\n\n⚠️ Encontré un movimiento bancario parecido (${candidato.descripcion || "sin descripción"}, ` +
      `${candidato.monto.toFixed(2)} €) pero no pude confirmar que quedó conciliado (estado: ${resultado.statusFinal}) — revísalo a mano en Holded.`
    );
  } catch (error) {
    console.error("[gastoCallbackHandler] Error intentando conciliar movimiento bancario:", error);
    return "";
  }
}

/**
 * Maneja los botones de propuestas de gasto (gasto_adjuntar / gasto_nuevo /
 * gasto_corregir / gasto_cancelar). Los únicos caminos que escriben algo
 * real en Holded son gasto_adjuntar y gasto_nuevo (y la confirmación tras
 * gasto_corregir) — nunca ocurre automáticamente.
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

  if (accion === "gasto_adjuntar" || accion === "gasto_nuevo") {
    const propuesta = await consumirPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Procesando...");
    await editTelegramMessage(propuesta.chatId, propuesta.messageId, `🔄 Procesando "${propuesta.proveedor}"...`, []);

    try {
      if (accion === "gasto_adjuntar") {
        const indice = Number(extra);
        const candidato = propuesta.candidatos[indice];
        if (!candidato) {
          throw new Error(`No se encontró el candidato #${indice + 1}.`);
        }

        await adjuntarYLimpiar(propuesta, candidato.id);
        await registrarClasificacionAprendida(propuesta.proveedor, propuesta.empresa, propuesta.concepto);
        const notaConciliacion = await intentarConciliar(propuesta.empresa, propuesta.monto, propuesta.fecha);

        await editTelegramMessage(
          propuesta.chatId,
          propuesta.messageId,
          `✅ Comprobante adjuntado al gasto de ${candidato.contactName} (${candidato.total.toFixed(2)} €, ${candidato.fecha}) en Holded.${notaConciliacion}`,
          []
        );
      } else {
        const mensaje = await crearGastoYReportar(propuesta, propuesta.empresa, propuesta.concepto);
        await editTelegramMessage(propuesta.chatId, propuesta.messageId, mensaje, []);
      }
    } catch (error) {
      if (error instanceof ContactoNoEncontradoError) {
        await manejarContactoNoEncontrado(propuesta, propuesta.empresa, propuesta.concepto, propuesta.chatId, propuesta.messageId);
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
    }
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

    try {
      const mensaje = await crearGastoYReportar(resolucion.propuesta, resolucion.empresaFinal, resolucion.conceptoFinal, {
        id: alternativa.contactId,
        name: alternativa.contactName,
      });
      await editTelegramMessage(resolucion.chatId, resolucion.messageId, mensaje, []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[gastoCallbackHandler] Error procesando gasto con contacto alternativo:", message);
      await editTelegramMessage(
        resolucion.chatId,
        resolucion.messageId,
        `⚠️ Error procesando "${resolucion.propuesta.proveedor}"\n\n${message}\n\nEl archivo local no se borró — puedes reenviarlo.`,
        []
      );
    }
    return;
  }

  if (accion === "gasto_sincontacto") {
    const resolucion = await consumirResolucionContacto(propuestaId);
    await answerCallbackQuerySafe(callback.id, "Ok.");
    if (resolucion) {
      await limpiarArchivoLocal(resolucion.propuesta.rutaLocal);
      await editTelegramMessage(
        resolucion.chatId,
        resolucion.messageId,
        `❌ Ok — crea el proveedor "${resolucion.propuesta.proveedor}" en Holded (${resolucion.empresaFinal}) y vuelve a mandar la factura.`,
        []
      );
    }
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}

/**
 * Crea el gasto en Holded (con el desglose de IVA de la propuesta), le
 * adjunta el comprobante, intenta conciliar el movimiento bancario
 * correspondiente, y devuelve el texto final para reportar — no manda el
 * mensaje él mismo, porque lo usan dos caminos distintos (editar un mensaje
 * existente vs. mandar uno nuevo tras una corrección).
 *
 * Si no se pasa `contactoForzado` y no se encuentra el proveedor, lanza
 * ContactoNoEncontradoError en vez de devolver un texto de error — quien la
 * llame decide si ofrece alternativas (ver manejarContactoNoEncontrado) o
 * falla directo. Cuando SÍ se pasa `contactoForzado` (el usuario confirmó
 * una alternativa), se salta la búsqueda y además aprende el alias para que
 * la próxima factura de este proveedor resuelva directo.
 */
async function crearGastoYReportar(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"],
  conceptoFinal: string,
  contactoForzado?: { id: string; name: string }
): Promise<string> {
  const contacto = contactoForzado ?? (await buscarContactoHolded(empresaFinal, propuesta.proveedor));
  if (!contacto) {
    throw new ContactoNoEncontradoError(propuesta.proveedor, empresaFinal);
  }

  const lineas =
    propuesta.lineas.length > 0
      ? propuesta.lineas
      : [{ concepto: conceptoFinal || propuesta.concepto, base: propuesta.monto, tipoIvaPct: 0 }];

  const gasto = await crearGastoHolded(empresaFinal, {
    contactId: contacto.id,
    fecha: propuesta.fecha || new Date().toISOString().slice(0, 10),
    descripcion: conceptoFinal || propuesta.concepto,
    lineas,
  });

  await adjuntarYLimpiar(propuesta, gasto.id);
  await registrarClasificacionAprendida(propuesta.proveedor, empresaFinal, conceptoFinal || propuesta.concepto);
  if (contactoForzado) {
    await registrarAliasProveedor(empresaFinal, propuesta.proveedor, contactoForzado.id, contactoForzado.name).catch(
      (error) => console.error("[gastoCallbackHandler] No se pudo guardar el alias de proveedor (no crítico):", error)
    );
  }
  const notaConciliacion = await intentarConciliar(empresaFinal, propuesta.monto, propuesta.fecha);

  return (
    `✅ Gasto creado en Holded (id ${gasto.id}, contacto ${contacto.name ?? propuesta.proveedor}, como borrador) ` +
    `y comprobante adjuntado.${notaConciliacion}`
  );
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

  if (alternativas.length === 0) {
    const textoFinal = `${encabezado}\n\nCréalo primero en Holded y vuelve a mandar la factura — no quiero adivinar a qué contacto asignarlo.`;
    if (messageId != null) {
      await editTelegramMessage(chatId, messageId, textoFinal, []);
    } else {
      await sendTelegramMessage(chatId, textoFinal);
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
  botones.push([{ text: "❌ Ninguna, crear en Holded", callback_data: `gasto_sincontacto:${resolucion.id}` }]);

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
    const mensaje = await crearGastoYReportar(propuesta, empresaFinal, conceptoFinal);
    await sendTelegramMessage(propuesta.chatId, mensaje);
  } catch (error) {
    if (error instanceof ContactoNoEncontradoError) {
      await manejarContactoNoEncontrado(propuesta, empresaFinal, conceptoFinal, propuesta.chatId, undefined);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error procesando corrección de gasto:", message);
    await sendTelegramMessage(pendiente.chatId, `⚠️ Error: ${message}\n\nEl archivo local no se borró — puedes reenviarlo.`);
  }
}
