import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { obtenerResumenColaPorChat } from "../gmail/colaRevisionStore";
import { obtenerPropuestaClasificacionPendientePorChat } from "../documental/classificationStore";
import { obtenerResolucionContactoPendientePorChat } from "../gastos/contactoResolucionStore";
import { obtenerGastoPendienteDatosPorChat } from "../gastos/gastoPendienteDatosStore";
import { obtenerPendienteReclasificacionPorChat } from "../documental/pendienteReclasificacionStore";
import { obtenerPendientesCapturaEmpresaPorChat } from "../knowledge/pendienteCapturaEmpresaStore";
import { obtenerPendienteAlertaDocumentoPorChat } from "../documental/pendienteAlertaDocumentoStore";
import { obtenerPendienteCorreccionGastoPorChat } from "../gastos/pendienteCorreccionGastoStore";
import { obtenerPendienteDesambiguacionPorChat } from "../documental/disambiguationStore";
import { obtenerPendienteEdicionBorradorPorChat } from "../gmail/emailDraftEditStore";
import { obtenerPendienteMontoPagoPorChat } from "../fiscal/pendienteMontoStore";
import { obtenerPendienteOrientacionAnotacionPorChat } from "./cashflowAnnotationOrientationStore";
import { obtenerPendienteOrientacionCorreoPorChat } from "../gmail/emailOrientationStore";
import { obtenerPendienteReglaClasificacionPorChat } from "../documental/pendienteReglaClasificacionStore";

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
    const { total, activo } = await obtenerResumenColaPorChat(chatId);
    if (total > 0) {
      items.push({
        descripcion: activo
          ? `📧 Correo esperando respuesta: "${truncar(activo.asunto, 60)}" (de ${activo.de})` +
            (total > 1 ? ` — quedan ${total} en la cola` : "")
          : `📧 ${total} correo(s) en la cola de revisión`,
        // fechaOrden es la fecha REAL de llegada del correo (ver
        // colaRevisionStore.ts) — a diferencia de agregadoEn, que en el
        // correo "activo" se reescribe a "cuándo se activó" (para detectar
        // estancamiento), no a cuándo llegó de verdad. Usar agregadoEn acá
        // mostraba "hace menos de 1h" para un correo real de hace 3 días
        // que recién pasó a activo.
        creadoEn: activo?.fechaOrden ?? Date.now(),
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
        descripcion: `👤 Contacto sin crear en Holded: "${r.propuesta.proveedor}" (${r.empresaFinal})`,
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
        descripcion: `💸 Gasto sin confirmar (falta ${queFalta}): "${g.datos.proveedor}" — ${g.datos.monto} ${g.datos.moneda}`,
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

      await sendTelegramMessage(admin.userId, texto);
    } catch (error) {
      console.error(`[resumenPendientesDiario] Error generando/enviando el resumen para ${admin.userId}:`, error);
    }
  }
}
