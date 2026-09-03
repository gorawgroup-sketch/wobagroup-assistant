import { unlink } from "node:fs/promises";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage, sendTelegramMessageWithButtons, answerCallbackQuery } from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { obtenerResumenColaPorChat, vaciarColaCorreoDelChat } from "../gmail/colaRevisionStore";
import { marcarHiloComoLeido } from "../gmail/client";
import { obtenerPropuestaClasificacionPendientePorChat, consumirPropuestaClasificacionPorChat } from "../documental/classificationStore";
import { obtenerResolucionContactoPendientePorChat } from "../gastos/contactoResolucionStore";
import { obtenerGastoPendienteDatosPorChat } from "../gastos/gastoPendienteDatosStore";
import { obtenerPendienteReclasificacionPorChat, consumirPendienteReclasificacionPorChat } from "../documental/pendienteReclasificacionStore";
import { obtenerPendientesCapturaEmpresaPorChat, eliminarPendienteCapturaEmpresa } from "../knowledge/pendienteCapturaEmpresaStore";
import { obtenerPendienteAlertaDocumentoPorChat, consumirPendienteAlertaDocumento } from "../documental/pendienteAlertaDocumentoStore";
import { obtenerPendienteCorreccionGastoPorChat, consumirPendienteCorreccionGasto } from "../gastos/pendienteCorreccionGastoStore";
import { obtenerPendienteAjusteMontoGastoPorChat, consumirPendienteAjusteMontoGasto } from "../gastos/pendienteAjusteMontoGastoStore";
import { obtenerPendienteAccionGastoPorChat, consumirPendienteAccionGasto } from "../gastos/pendienteAccionGastoStore";
import { obtenerPendienteSeleccionGastoPorChat, consumirPendienteSeleccionGasto } from "../gastos/pendienteSeleccionGastoStore";
import { etiquetaAccion } from "../gastos/gastoTeclado";
import { obtenerPendienteDesambiguacionPorChat, consumirPendienteDesambiguacion } from "../documental/disambiguationStore";
import { obtenerPendienteEdicionBorradorPorChat, consumirPendienteEdicionBorrador } from "../gmail/emailDraftEditStore";
import { obtenerPendienteMontoPagoPorChat, consumirPendienteMontoPago } from "../fiscal/pendienteMontoStore";
import { obtenerPendienteOrientacionAnotacionPorChat, consumirPendienteOrientacionAnotacion } from "./cashflowAnnotationOrientationStore";
import { obtenerPendienteOrientacionCorreoPorChat, consumirPendienteOrientacionCorreo } from "../gmail/emailOrientationStore";
import { obtenerPendienteReglaClasificacionPorChat, consumirPendienteReglaClasificacion } from "../documental/pendienteReglaClasificacionStore";

interface ItemPendiente {
  descripcion: string;
  creadoEn: number;
}

/**
 * Pedido explícito de Carlos, tras el caso real de Dylo (2026-09-03): "cómo
 * nos aseguramos que en el chat no queden cosas pendientes o en loops que
 * bloqueen el funcionamiento". El sistema tiene ~14 "pendiente_*" separados
 * (cola de correo, propuesta de archivo, contacto, gasto con datos
 * faltantes, reclasificación de documento, captura sin confirmar, alerta de
 * documento, corrección de gasto, desambiguación, edición de borrador,
 * monto de pago recurrente, orientación de anotación, orientación de
 * correo, regla de clasificación) — cada uno hecho a mano, cada uno con su
 * propio TTL, y hasta ahora sin ningún lugar único donde ver "qué me quedó
 * sin resolver". Este job los recorre TODOS, por cada admin/superadmin
 * (cada uno tiene sus propios pendientes en su propio chat, resuelto vía
 * admin.userId — verificado en vivo que hoy coincide exactamente con
 * CASHFLOW_ALERTS_CHAT_ID, el único admin real es Carlos), y manda UN
 * resumen diario — silencioso si no hay nada, igual que el resto de los
 * crons de este proyecto.
 *
 * Es la fase 1 de la solución (recorrer y AVISAR) — barata de construir,
 * pero no "sin riesgo" para el futuro: esta es ya la TERCERA lista escrita a
 * mano de "cuáles son los stores de pendientes" en el proyecto (las otras
 * dos: la lista de hints en buildSystemPromptDinamico y la lista corta en
 * haySensiblePendiente/obtenerPendientesSensibles, ambas en
 * core/claude/client.ts) — un tipo de pendiente nuevo que alguien agregue
 * solo acá no queda protegido por esa otra lógica (ni al revés). La fase 2
 * —consolidar los ~14 stores en un registro único que ambas partes
 * recorran— queda pendiente de planear aparte, deliberadamente: tocar
 * ahora mismo la lógica de enrutamiento de IA (recién corregida esta misma
 * sesión por un bug real) solo para no repetir 14 lecturas de solo lectura
 * una vez al día es más riesgo del que vale la pena correr hoy.
 *
 * Reemplaza al aviso más angosto de las 7pm (avisarPendientesCorreo7pm, que
 * solo cubría la cola de correo) — mismo horario, ahora con todo.
 */
function formatAntiguedad(creadoEn: number): string {
  const ms = Date.now() - creadoEn;
  const horas = Math.floor(ms / (60 * 60 * 1000));
  if (horas < 1) return "hace menos de 1h";
  if (horas < 24) return `hace ${horas}h`;
  const dias = Math.floor(horas / 24);
  return `hace ${dias} día${dias === 1 ? "" : "s"}`;
}

function truncar(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}

async function recolectarPendientes(chatId: number): Promise<ItemPendiente[]> {
  const items: ItemPendiente[] = [];

  try {
    const { total, activo, masAntiguo } = await obtenerResumenColaPorChat(chatId);
    if (total > 0) {
      items.push({
        descripcion: activo
          ? `📧 Correo esperando respuesta: "${truncar(activo.asunto, 60)}" (de ${activo.de})` +
            (total > 1 ? ` — quedan ${total} en la cola` : "")
          : `📧 ${total} correo(s) en la cola de revisión — en pausa, esperando "▶️ Sí, siguiente"`,
        // fechaOrden es la fecha REAL de llegada del correo (ver
        // colaRevisionStore.ts) — a diferencia de agregadoEn, que en el
        // correo "activo" se reescribe a "cuándo se activó" (para detectar
        // estancamiento), no a cuándo llegó de verdad. Usar agregadoEn acá
        // mostraba "hace menos de 1h" para un correo real de hace 3 días
        // que recién pasó a activo. Bug real de auditoría: con la cola en
        // pausa (nada activo, esperando el botón) esto caía en Date.now()
        // y SIEMPRE mostraba "hace menos de 1h" sin importar la antigüedad
        // real — masAntiguo (por fechaOrden) cubre también ese caso.
        creadoEn: activo?.fechaOrden ?? masAntiguo?.fechaOrden ?? Date.now(),
      });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando cola de correo (no crítico):", error);
  }

  try {
    const p = await obtenerPropuestaClasificacionPendientePorChat(chatId);
    if (p) items.push({ descripcion: `📁 Propuesta de archivo sin responder: "${truncar(p.nombreArchivoOriginal, 60)}"`, creadoEn: p.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando propuesta de archivo (no crítico):", error);
  }

  try {
    const r = await obtenerResolucionContactoPendientePorChat(chatId);
    if (r) {
      items.push({
        // "🗑️ Descartar todo" NO toca esto — trae una PropuestaGasto real
        // adentro (dinero ya extraído, solo falta el contacto en Holded).
        descripcion: `👤 Contacto sin crear en Holded: "${r.propuesta.proveedor}" (${r.empresaFinal}) — revisar individual, no se borra con "Descartar todo"`,
        creadoEn: r.creadoEn,
      });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando resolución de contacto (no crítico):", error);
  }

  try {
    const g = await obtenerGastoPendienteDatosPorChat(chatId);
    if (g) {
      const queFalta = g.motivo === "empresa" ? "empresa" : "monto/moneda exactos";
      items.push({
        descripcion: `💸 Gasto sin confirmar (falta ${queFalta}): "${g.datos.proveedor}" — ${g.datos.monto} ${g.datos.moneda} — revisar individual, no se borra con "Descartar todo"`,
        creadoEn: g.creadoEn,
      });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando gasto pendiente de datos (no crítico):", error);
  }

  try {
    const rc = await obtenerPendienteReclasificacionPorChat(chatId);
    if (rc) items.push({ descripcion: `🗂️ Falta elegir carpeta para: "${truncar(rc.nombreArchivoOriginal, 60)}"`, creadoEn: rc.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando reclasificación de documento (no crítico):", error);
  }

  try {
    const capturas = await obtenerPendientesCapturaEmpresaPorChat(chatId);
    for (const c of capturas) {
      items.push({ descripcion: `📌 Captura sin confirmar: "${truncar(c.texto, 60)}"`, creadoEn: c.creadoEn });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando capturas sin confirmar (no crítico):", error);
  }

  try {
    const a = await obtenerPendienteAlertaDocumentoPorChat(chatId);
    if (a) items.push({ descripcion: `⏰ Falta indicar cuándo avisar sobre: "${truncar(a.nombreArchivoOriginal, 60)}"`, creadoEn: a.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando alerta de documento (no crítico):", error);
  }

  try {
    const cg = await obtenerPendienteCorreccionGastoPorChat(chatId);
    if (cg) items.push({ descripcion: `✏️ Falta el detalle de una corrección de gasto`, creadoEn: cg.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando corrección de gasto (no crítico):", error);
  }

  try {
    const am = await obtenerPendienteAjusteMontoGastoPorChat(chatId);
    if (am) items.push({ descripcion: `💰 Falta el monto ajustado de una propuesta de gasto`, creadoEn: am.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando ajuste de monto de gasto (no crítico):", error);
  }

  try {
    const aa = await obtenerPendienteAccionGastoPorChat(chatId);
    if (aa) items.push({ descripcion: `✏️ Falta tu instrucción sobre el correo de una propuesta de gasto`, creadoEn: aa.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando otras acciones de gasto (no crítico):", error);
  }

  try {
    const sg = await obtenerPendienteSeleccionGastoPorChat(chatId);
    if (sg) {
      const [siguiente] = sg.colaAcciones;
      items.push({
        descripcion: `▶️ Falta tu respuesta para aplicar "${siguiente ? etiquetaAccion(siguiente) : "una acción"}" de una selección aprobada en una propuesta de gasto`,
        creadoEn: sg.creadoEn,
      });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando la cola de selección de gasto (no crítico):", error);
  }

  try {
    const d = await obtenerPendienteDesambiguacionPorChat(chatId);
    if (d) items.push({ descripcion: `❓ Falta aclarar: "${truncar(d.preguntaFormulada, 60)}"`, creadoEn: d.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando desambiguación (no crítico):", error);
  }

  try {
    const eb = await obtenerPendienteEdicionBorradorPorChat(chatId);
    if (eb) items.push({ descripcion: `✉️ Falta el texto de una edición de borrador de correo`, creadoEn: eb.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando edición de borrador (no crítico):", error);
  }

  try {
    const mp = await obtenerPendienteMontoPagoPorChat(chatId);
    if (mp) items.push({ descripcion: `💳 Falta el monto de: "${mp.concepto}" (${mp.empresaHolded})`, creadoEn: mp.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando monto de pago recurrente (no crítico):", error);
  }

  try {
    const oa = await obtenerPendienteOrientacionAnotacionPorChat(chatId);
    if (oa) items.push({ descripcion: `📝 Falta tu instrucción sobre una anotación de cashflow: "${truncar(oa.ubicacion, 60)}"`, creadoEn: oa.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando orientación de anotación (no crítico):", error);
  }

  try {
    const oc = await obtenerPendienteOrientacionCorreoPorChat(chatId);
    if (oc) items.push({ descripcion: `📨 Falta tu instrucción sobre el correo: "${truncar(oc.asunto, 60)}" (de ${oc.de})`, creadoEn: oc.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando orientación de correo (no crítico):", error);
  }

  try {
    const rg = await obtenerPendienteReglaClasificacionPorChat(chatId);
    if (rg) items.push({ descripcion: `📚 Falta el criterio de una regla de clasificación para: "${truncar(rg.nombreArchivoOriginal, 60)}"`, creadoEn: rg.creadoEn });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando regla de clasificación (no crítico):", error);
  }

  return items;
}

export async function enviarResumenPendientesDiario(): Promise<void> {
  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error("[resumenPendientesDiario] No hay ningún admin registrado, no se puede notificar.");
    return;
  }

  for (const admin of admins) {
    try {
      const items = await recolectarPendientes(admin.userId);
      if (items.length === 0) continue;

      items.sort((a, b) => a.creadoEn - b.creadoEn);
      const texto = [
        `🕖 Fin del día — te quedan ${items.length} cosa${items.length === 1 ? "" : "s"} pendiente${items.length === 1 ? "" : "s"} sin resolver:`,
        "",
        ...items.map((it) => `• ${it.descripcion} (${formatAntiguedad(it.creadoEn)})`),
      ].join("\n");

      // Pedido explícito de Carlos: si al final del día algo ya no hace
      // falta (lo resolvió por su cuenta, o ya no aplica), poder "dejar
      // todo libre" desde acá mismo en vez de ir mensaje por mensaje.
      await sendTelegramMessageWithButtons(admin.userId, texto, [
        [{ text: "🗑️ Descartar todo", callback_data: "resumen_descartar_todo" }],
      ]);
    } catch (error) {
      console.error(`[resumenPendientesDiario] Error generando/enviando el resumen para ${admin.userId}:`, error);
    }
  }
}

/**
 * Maneja el botón "🗑️ Descartar todo" del resumen diario — pedido explícito
 * de Carlos. Descarta la cola de correo completa, las propuestas de archivo
 * (puede haber varias por chat — se drenan una por una hasta que no quede
 * ninguna) y los "pendiente_*" de un solo cupo por chat que NO tienen datos
 * financieros reales adentro. Deliberadamente NO toca nada que represente
 * dinero real ya extraído: ni las propuestas de GASTO
 * (core/gastos/gastoProposalSheet.ts, que ya no se listan en este resumen),
 * ni resolucionContactoPendientePorChat (auditoría: encontrado en vivo que
 * ESTE guarda una PropuestaGasto completa adentro — solo falta crear el
 * contacto en Holded, no es un simple recordatorio), ni
 * gastoPendienteDatosPorChat (ya trae proveedor/monto reales extraídos de
 * una factura real, solo falta la empresa o el monto exacto) — esos dos se
 * quedan fuera del descarte masivo por el mismo criterio que las propuestas
 * de gasto: siempre revisión individual, nunca en bloque.
 */
async function descartarTodosLosPendientes(chatId: number): Promise<number> {
  let n = 0;

  // Se cuenta como "1 cosa menos" (igual que el resumen la muestra como una
  // sola línea), no como la cantidad real de filas de correo eliminadas —
  // bug real de auditoría: antes sumaba el conteo crudo de filas, que podía
  // no coincidir para nada con "cuántas cosas" decía el resumen justo
  // arriba de este mismo botón.
  const hilosCorreoBorrados = await vaciarColaCorreoDelChat(chatId).catch((error) => {
    console.error("[resumenPendientesDiario] Error vaciando la cola de correo (no crítico):", error);
    return [] as string[];
  });
  if (hilosCorreoBorrados.length > 0) n += 1;
  // Bug real encontrado en vivo (2026-09-03): sin esto, Gmail seguía
  // contando estos hilos como sin leer para siempre (is:unread es la única
  // fuente de verdad de la cola) y la siguiente revisión horaria los volvía
  // a encolar solos, deshaciendo el "Descartar todo" sin avisar — es una
  // decisión explícita del usuario, se marcan leídos de verdad.
  for (const threadId of hilosCorreoBorrados) {
    marcarHiloComoLeido(threadId).catch((error: unknown) =>
      console.error(`[resumenPendientesDiario] Error marcando el hilo ${threadId} como leído (no crítico):`, error)
    );
  }

  try {
    // Puede haber varias propuestas de archivo pendientes del mismo chat —
    // se drena una por una (consumirPropuestaClasificacionPorChat siempre
    // toma la más reciente) hasta que no quede ninguna.
    let propuesta = await consumirPropuestaClasificacionPorChat(chatId);
    while (propuesta) {
      await unlink(propuesta.rutaLocal).catch(() => {});
      n += 1;
      propuesta = await consumirPropuestaClasificacionPorChat(chatId);
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error descartando propuestas de archivo (no crítico):", error);
  }

  const conArchivoLocal: Array<() => Promise<{ rutaLocal: string } | undefined>> = [
    () => consumirPendienteReclasificacionPorChat(chatId),
    () => consumirPendienteDesambiguacion(chatId),
  ];
  for (const consumir of conArchivoLocal) {
    try {
      const pendiente = await consumir();
      if (pendiente) {
        await unlink(pendiente.rutaLocal).catch(() => {});
        n += 1;
      }
    } catch (error) {
      console.error("[resumenPendientesDiario] Error descartando un pendiente con archivo local (no crítico):", error);
    }
  }

  const sinArchivoLocal: Array<() => Promise<unknown>> = [
    () => consumirPendienteAlertaDocumento(chatId),
    () => consumirPendienteCorreccionGasto(chatId),
    () => consumirPendienteAjusteMontoGasto(chatId),
    () => consumirPendienteAccionGasto(chatId),
    () => consumirPendienteSeleccionGasto(chatId),
    () => consumirPendienteEdicionBorrador(chatId),
    () => consumirPendienteMontoPago(chatId),
    () => consumirPendienteOrientacionAnotacion(chatId),
    () => consumirPendienteOrientacionCorreo(chatId),
    () => consumirPendienteReglaClasificacion(chatId),
  ];
  for (const consumir of sinArchivoLocal) {
    try {
      const pendiente = await consumir();
      if (pendiente) n += 1;
    } catch (error) {
      console.error("[resumenPendientesDiario] Error descartando un pendiente (no crítico):", error);
    }
  }

  try {
    const capturas = await obtenerPendientesCapturaEmpresaPorChat(chatId);
    for (const c of capturas) {
      await eliminarPendienteCapturaEmpresa(chatId, c.messageId);
      n += 1;
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error descartando capturas sin confirmar (no crítico):", error);
  }

  return n;
}

export async function handleDescartarTodoPendienteCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;

  try {
    await answerCallbackQuery(callback.id);
  } catch (error) {
    console.error("[resumenPendientesDiario] No se pudo responder el callback_query (no crítico):", error);
  }

  if (chatId === undefined) return;

  const n = await descartarTodosLosPendientes(chatId);
  await sendTelegramMessage(
    chatId,
    n > 0
      ? `🗑️ Descartado — ${n} cosa${n === 1 ? "" : "s"} pendiente${n === 1 ? "" : "s"} menos (las propuestas de gasto NO se tocaron, esas siguen una por una).`
      : "Ya no quedaba nada pendiente para descartar."
  ).catch(() => {});
}
