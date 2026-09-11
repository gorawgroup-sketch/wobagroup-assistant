import { unlink } from "node:fs/promises";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { esDiaHabilEspana } from "../utils/diaHabil";
import { sendTelegramMessage, sendTelegramMessageWithButtons, answerCallbackQuery } from "../telegram/client";
import type { TelegramCallbackQuery, InlineKeyboardButton } from "../telegram/types";
import { obtenerResumenColaPorChat, vaciarColaCorreoDelChat } from "../gmail/colaRevisionStore";
import { obtenerPropuestaClasificacionPendientePorChat, consumirPropuestaClasificacionPorChat, consumirPropuestaClasificacion } from "../documental/classificationStore";
import { obtenerResolucionContactoPendientePorChat } from "../gastos/contactoResolucionStore";
import { obtenerGastoPendienteDatosPorChat } from "../gastos/gastoPendienteDatosStore";
import { obtenerPendientesEdicionCompraHoldedPorChat } from "../holded/pendienteEdicionCompraHoldedStore";
import { obtenerPendientesEdicionValorCashflowPorChat } from "../google/pendienteEdicionValorCashflowStore";
import { obtenerPendientesRegistroManualCashflowPorChat } from "../google/pendienteRegistroManualCashflowStore";
import { obtenerPendienteReclasificacionPorChat, consumirPendienteReclasificacionPorChat } from "../documental/pendienteReclasificacionStore";
import { obtenerPendientesCapturaEmpresaPorChat, eliminarPendienteCapturaEmpresa } from "../knowledge/pendienteCapturaEmpresaStore";
import { obtenerPendienteAlertaDocumentoPorChat, consumirPendienteAlertaDocumento } from "../documental/pendienteAlertaDocumentoStore";
import { obtenerPendienteCorreccionGastoPorChat, consumirPendienteCorreccionGasto } from "../gastos/pendienteCorreccionGastoStore";
import { obtenerPendienteAjusteMontoGastoPorChat, consumirPendienteAjusteMontoGasto } from "../gastos/pendienteAjusteMontoGastoStore";
import { obtenerPendienteAccionGastoPorChat, consumirPendienteAccionGasto } from "../gastos/pendienteAccionGastoStore";
import { obtenerPendienteSeleccionGastoPorChat, consumirPendienteSeleccionGasto } from "../gastos/pendienteSeleccionGastoStore";
import { etiquetaAccion } from "../gastos/gastoTeclado";
import { obtenerPendienteDesambiguacionPorChat, consumirPendienteDesambiguacion, consumirPendienteDesambiguacionPorId } from "../documental/disambiguationStore";
import { obtenerPendienteEdicionBorradorPorChat, consumirPendienteEdicionBorrador } from "../gmail/emailDraftEditStore";
import { obtenerPendienteMontoPagoPorChat, consumirPendienteMontoPago } from "../fiscal/pendienteMontoStore";
import { obtenerPendienteOrientacionAnotacionPorChat, consumirPendienteOrientacionAnotacion } from "./cashflowAnnotationOrientationStore";
import { obtenerPendienteOrientacionCorreoPorChat, consumirPendienteOrientacionCorreo } from "../gmail/emailOrientationStore";
import { obtenerPendienteReglaClasificacionPorChat, consumirPendienteReglaClasificacion } from "../documental/pendienteReglaClasificacionStore";
import { obtenerPendientesHiloAutorespuestaPorChat } from "../gmail/hiloAutorespuestaStore";
import { obtenerPendientesAutorrepairPorChat } from "../github/autorrepairPendienteStore";

/**
 * Caso real reportado por Carlos: el resumen de fin de día solo traía "🗑️ Descartar todo" — sin
 * forma de descartar UNO de los pendientes opcionales y dejar los demás para seguir revisando. Sus
 * palabras: "Debería yo tener todas las alternativas para descartar lo necesario y continuar con lo
 * que requiera continuar." `tipo` (+ `subId` cuando puede haber varios del mismo tipo a la vez, ej.
 * desambiguación) identifica a cuál store/consumir-function apunta el botón individual de cada línea
 * — ver TIPOS_DESCARTABLES y descartarUnPendiente más abajo. Los tipos SIN `tipo` (contacto/gasto con
 * datos reales, edición de Holded, hilo de autorespuesta, autorrepair) se quedan sin botón individual
 * a propósito — mismo criterio que ya excluye a esos de "Descartar todo": son dinero o decisiones
 * demasiado consecuentes para un descarte casual, siempre se revisan de verdad.
 */
interface ItemPendiente {
  descripcion: string;
  creadoEn: number;
  tipo?: TipoPendienteDescartable;
  subId?: string;
}

type TipoPendienteDescartable =
  | "cola_correo_activo"
  | "propuesta_archivo"
  | "reclasificacion"
  | "captura_empresa"
  | "alerta_documento"
  | "correccion_gasto"
  | "ajuste_monto_gasto"
  | "accion_gasto"
  | "seleccion_gasto"
  | "desambiguacion"
  | "edicion_borrador"
  | "monto_pago"
  | "orientacion_anotacion"
  | "orientacion_correo"
  | "regla_clasificacion";

/**
 * Hallazgo CRÍTICO de auditoría: el callback_data de Telegram tiene un límite de 64 bytes. Con el
 * nombre completo del tipo (ej. "resumen_descartar_item:desambiguacion:" + un id completo de
 * disambiguationStore.ts, un randomUUID() de 36 caracteres) el botón sale con 75 bytes — Telegram
 * rechaza el mensaje ENTERO (los 14 tipos posibles, no solo ese botón), así que ningún día con una
 * desambiguación pendiente habría mandado el resumen — exactamente el "algo queda bloqueado en
 * silencio" que esta función existe para evitar. Un código corto de 2 letras por tipo (nunca visible,
 * solo va en el callback_data) deja margen de sobra incluso con el id más largo posible.
 */
const CODIGO_POR_TIPO: Record<Exclude<TipoPendienteDescartable, "cola_correo_activo">, string> = {
  propuesta_archivo: "pa",
  reclasificacion: "rc",
  captura_empresa: "ce",
  alerta_documento: "ad",
  correccion_gasto: "cg",
  ajuste_monto_gasto: "am",
  accion_gasto: "ag",
  seleccion_gasto: "sg",
  desambiguacion: "db",
  edicion_borrador: "eb",
  monto_pago: "mp",
  orientacion_anotacion: "oa",
  orientacion_correo: "oc",
  regla_clasificacion: "rg",
};

const TIPO_POR_CODIGO: Record<string, Exclude<TipoPendienteDescartable, "cola_correo_activo">> = Object.fromEntries(
  Object.entries(CODIGO_POR_TIPO).map(([tipo, codigo]) => [codigo, tipo])
) as Record<string, Exclude<TipoPendienteDescartable, "cola_correo_activo">>;

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
        // Solo cuando hay un correo ACTIVO puntual tiene sentido "descartar este" — reutiliza el
        // mismo botón/callback que ya existe (colacorreo_descartaractivo, ver revisarCorreoNuevo.ts)
        // en vez de uno nuevo; con la cola en pausa (nada activo todavía) no hay un ítem puntual que
        // saltar, solo "▶️ Sí, siguiente" tiene sentido ahí.
        tipo: activo ? "cola_correo_activo" : undefined,
      });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando cola de correo (no crítico):", error);
  }

  try {
    const p = await obtenerPropuestaClasificacionPendientePorChat(chatId);
    if (p) items.push({ descripcion: `📁 Propuesta de archivo sin responder: "${truncar(p.nombreArchivoOriginal, 60)}"`, creadoEn: p.creadoEn, tipo: "propuesta_archivo", subId: p.id });
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
    const ediciones = await obtenerPendientesEdicionCompraHoldedPorChat(chatId);
    for (const e of ediciones) {
      // "🗑️ Descartar todo" NO toca esto — cambios.montoNuevo puede traer un
      // monto real ya extraído, mismo criterio que resolucionContactoPendientePorChat/
      // gastoPendienteDatosPorChat arriba.
      items.push({
        descripcion: `✏️ Edición de Holded sin aprobar: "${e.resumenAntes}" — revisar individual, no se borra con "Descartar todo"`,
        creadoEn: e.creadoEn,
      });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando ediciones de compra en Holded (no crítico):", error);
  }

  try {
    const edicionesCashflow = await obtenerPendientesEdicionValorCashflowPorChat(chatId);
    for (const e of edicionesCashflow) {
      // Mismo criterio que las ediciones de Holded arriba: dato de dinero
      // real ya identificado, nunca se descarta con "Descartar todo".
      items.push({
        descripcion: `✏️ Edición de cashflow sin aprobar: "${e.resumenAntes}" → ${e.valorNuevo.toFixed(2)} — revisar individual, no se borra con "Descartar todo"`,
        creadoEn: e.creadoEn,
      });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando ediciones de valor en cashflow (no crítico):", error);
  }

  try {
    const registrosCashflow = await obtenerPendientesRegistroManualCashflowPorChat(chatId);
    for (const r of registrosCashflow) {
      // Mismo criterio que las ediciones de cashflow arriba: dato de dinero
      // real ya identificado, nunca se descarta con "Descartar todo".
      items.push({
        descripcion: `🆕 Registro nuevo en cashflow sin aprobar: "${r.resumen}" — revisar individual, no se borra con "Descartar todo"`,
        creadoEn: r.creadoEn,
      });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando registros manuales de cashflow (no crítico):", error);
  }

  try {
    const rc = await obtenerPendienteReclasificacionPorChat(chatId);
    if (rc) items.push({ descripcion: `🗂️ Falta elegir carpeta para: "${truncar(rc.nombreArchivoOriginal, 60)}"`, creadoEn: rc.creadoEn, tipo: "reclasificacion" });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando reclasificación de documento (no crítico):", error);
  }

  try {
    const capturas = await obtenerPendientesCapturaEmpresaPorChat(chatId);
    for (const c of capturas) {
      items.push({ descripcion: `📌 Captura sin confirmar: "${truncar(c.texto, 60)}"`, creadoEn: c.creadoEn, tipo: "captura_empresa", subId: String(c.messageId) });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando capturas sin confirmar (no crítico):", error);
  }

  try {
    const a = await obtenerPendienteAlertaDocumentoPorChat(chatId);
    if (a) items.push({ descripcion: `⏰ Falta indicar cuándo avisar sobre: "${truncar(a.nombreArchivoOriginal, 60)}"`, creadoEn: a.creadoEn, tipo: "alerta_documento" });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando alerta de documento (no crítico):", error);
  }

  try {
    const hilos = await obtenerPendientesHiloAutorespuestaPorChat(chatId);
    for (const h of hilos) {
      items.push({ descripcion: `🤖 Falta decidir si es automática la conversación con ${h.de} ("${truncar(h.asunto, 60)}")`, creadoEn: h.creadoEn });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando hilos de conversación automática sin decidir (no crítico):", error);
  }

  try {
    const autorrepairs = await obtenerPendientesAutorrepairPorChat(chatId);
    for (const a of autorrepairs) {
      items.push({ descripcion: `🔧 Falta aprobar/descartar un arreglo de código propuesto en \`${a.ruta}\` (${a.urlPR})`, creadoEn: a.creadoEn });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando propuestas de autorrepación (no crítico):", error);
  }

  try {
    const cg = await obtenerPendienteCorreccionGastoPorChat(chatId);
    if (cg) items.push({ descripcion: `✏️ Falta el detalle de una corrección de gasto`, creadoEn: cg.creadoEn, tipo: "correccion_gasto" });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando corrección de gasto (no crítico):", error);
  }

  try {
    const am = await obtenerPendienteAjusteMontoGastoPorChat(chatId);
    if (am) items.push({ descripcion: `💰 Falta el monto ajustado de una propuesta de gasto`, creadoEn: am.creadoEn, tipo: "ajuste_monto_gasto" });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando ajuste de monto de gasto (no crítico):", error);
  }

  try {
    const aa = await obtenerPendienteAccionGastoPorChat(chatId);
    if (aa) items.push({ descripcion: `✏️ Falta tu instrucción sobre el correo de una propuesta de gasto`, creadoEn: aa.creadoEn, tipo: "accion_gasto" });
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
        tipo: "seleccion_gasto",
      });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando la cola de selección de gasto (no crítico):", error);
  }

  try {
    // Puede haber varias a la vez (una por adjunto ambiguo, ver disambiguationStore.ts) — una línea por cada una.
    const desambiguaciones = await obtenerPendienteDesambiguacionPorChat(chatId);
    for (const d of desambiguaciones) {
      items.push({ descripcion: `❓ Falta aclarar: "${truncar(d.preguntaFormulada, 60)}"`, creadoEn: d.creadoEn, tipo: "desambiguacion", subId: d.id });
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando desambiguación (no crítico):", error);
  }

  try {
    const eb = await obtenerPendienteEdicionBorradorPorChat(chatId);
    if (eb) items.push({ descripcion: `✉️ Falta el texto de una edición de borrador de correo`, creadoEn: eb.creadoEn, tipo: "edicion_borrador" });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando edición de borrador (no crítico):", error);
  }

  try {
    const mp = await obtenerPendienteMontoPagoPorChat(chatId);
    if (mp) items.push({ descripcion: `💳 Falta el monto de: "${mp.concepto}" (${mp.empresaHolded})`, creadoEn: mp.creadoEn, tipo: "monto_pago" });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando monto de pago recurrente (no crítico):", error);
  }

  try {
    const oa = await obtenerPendienteOrientacionAnotacionPorChat(chatId);
    if (oa) items.push({ descripcion: `📝 Falta tu instrucción sobre una anotación de cashflow: "${truncar(oa.ubicacion, 60)}"`, creadoEn: oa.creadoEn, tipo: "orientacion_anotacion" });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando orientación de anotación (no crítico):", error);
  }

  try {
    const oc = await obtenerPendienteOrientacionCorreoPorChat(chatId);
    if (oc) items.push({ descripcion: `📨 Falta tu instrucción sobre el correo: "${truncar(oc.asunto, 60)}" (de ${oc.de})`, creadoEn: oc.creadoEn, tipo: "orientacion_correo" });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando orientación de correo (no crítico):", error);
  }

  try {
    const rg = await obtenerPendienteReglaClasificacionPorChat(chatId);
    if (rg) items.push({ descripcion: `📚 Falta el criterio de una regla de clasificación para: "${truncar(rg.nombreArchivoOriginal, 60)}"`, creadoEn: rg.creadoEn, tipo: "regla_clasificacion" });
  } catch (error) {
    console.error("[resumenPendientesDiario] Error consultando regla de clasificación (no crítico):", error);
  }

  return items;
}

/** Pedido explícito de Carlos: "no envíes avisos en fin de semana... solo avisos en días hábiles españoles". */
export async function enviarResumenPendientesDiario(): Promise<void> {
  if (!esDiaHabilEspana()) {
    console.log("[resumenPendientesDiario] Fin de semana, no se envía el resumen.");
    return;
  }

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
        ...items.map((it, i) => `${i + 1}. ${it.descripcion} (${formatAntiguedad(it.creadoEn)})`),
      ].join("\n");

      // Caso real reportado por Carlos: antes SOLO había "Descartar todo" — sin forma de descartar
      // uno solo de los opcionales y seguir revisando el resto. Un botón por cada línea descartable
      // (numerado igual que la lista de arriba, para que se entienda a cuál corresponde cada uno),
      // más "Descartar todo" para cuando de verdad no queda nada por revisar. Los tipos sin `tipo`
      // (dinero real, ediciones de Holded, hilos de autorespuesta, autorrepair) no traen botón
      // individual a propósito — mismo criterio que ya los excluye de "Descartar todo".
      const botonesIndividuales: InlineKeyboardButton[][] = items
        .map((it, i) => ({ it, indice: i + 1 }))
        .filter(({ it }) => it.tipo !== undefined)
        .map(({ it, indice }) => [
          {
            text: `🗑️ Descartar #${indice}`,
            callback_data:
              it.tipo === "cola_correo_activo"
                ? "colacorreo_descartaractivo"
                : `resumen_descartar_item:${CODIGO_POR_TIPO[it.tipo as Exclude<TipoPendienteDescartable, "cola_correo_activo">]}:${it.subId ?? ""}`,
          },
        ]);

      // Pedido explícito de Carlos: si al final del día algo ya no hace
      // falta (lo resolvió por su cuenta, o ya no aplica), poder "dejar
      // todo libre" desde acá mismo en vez de ir mensaje por mensaje.
      await sendTelegramMessageWithButtons(admin.userId, texto, [
        ...botonesIndividuales,
        [{ text: "🧹 Limpiar pendientes", callback_data: "resumen_descartar_todo" }],
      ]);
    } catch (error) {
      console.error(`[resumenPendientesDiario] Error generando/enviando el resumen para ${admin.userId}:`, error);
    }
  }
}

/**
 * Ejecuta la limpieza masiva del resumen diario — pedido explícito de
 * Carlos. Retira la cola LOCAL de correo, las propuestas de archivo
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
 *
 * Invariante crítico (Carlos, 2026-09-11): vaciar esta cola interna NUNCA
 * modifica Gmail. Los hilos siguen con UNREAD y vuelven a aparecer en la
 * siguiente revisión; solo una resolución individual del correo puede
 * marcarlo como leído. El test de arquitectura asociado impide reintroducir
 * una llamada a marcarHiloComoLeido en este flujo.
 */
async function descartarTodosLosPendientes(chatId: number): Promise<number> {
  let n = 0;

  // Se cuenta como "1 cosa menos" (igual que el resumen la muestra como una
  // sola línea), no como la cantidad real de filas de correo eliminadas —
  // bug real de auditoría: antes sumaba el conteo crudo de filas, que podía
  // no coincidir para nada con "cuántas cosas" decía el resumen justo
  // arriba de este mismo botón.
  const hilosRetiradosDeColaLocal = await vaciarColaCorreoDelChat(chatId).catch((error) => {
    console.error("[resumenPendientesDiario] Error vaciando la cola de correo (no crítico):", error);
    return [] as string[];
  });
  if (hilosRetiradosDeColaLocal.length > 0) n += 1;

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

  try {
    // Puede haber varias preguntas de desambiguación pendientes del mismo chat a la vez (una por
    // adjunto ambiguo, ver disambiguationStore.ts) — se drena una por una hasta que no quede ninguna,
    // mismo bucle que las propuestas de archivo arriba (el orden de consumo difiere entre ambas —
    // acá siempre la más antigua, arriba siempre la más reciente — pero no importa para un drenado
    // completo: al final las dos dejan la lista vacía igual).
    let pendiente = await consumirPendienteDesambiguacion(chatId);
    while (pendiente) {
      await unlink(pendiente.rutaLocal).catch(() => {});
      n += 1;
      pendiente = await consumirPendienteDesambiguacion(chatId);
    }
  } catch (error) {
    console.error("[resumenPendientesDiario] Error descartando preguntas de desambiguación (no crítico):", error);
  }

  const conArchivoLocal: Array<() => Promise<{ rutaLocal: string } | undefined>> = [
    () => consumirPendienteReclasificacionPorChat(chatId),
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

/**
 * Descarta UN SOLO pendiente (una línea del resumen de fin de día), identificado por `tipo` (+
 * `subId` cuando ese tipo puede tener varios a la vez, ver ItemPendiente arriba) — pedido explícito
 * de Carlos: "debería yo tener todas las alternativas para descartar lo necesario y continuar con lo
 * que requiera continuar", en vez de solo "Descartar todo". Reutiliza exactamente las mismas
 * funciones consumir_* que ya usa descartarTodosLosPendientes, solo que apuntadas a UN registro en
 * vez de vaciar el store entero. Devuelve true si de verdad había algo que descartar.
 */
async function descartarUnPendiente(chatId: number, tipo: TipoPendienteDescartable, subId: string): Promise<boolean> {
  switch (tipo) {
    case "cola_correo_activo":
      // No debería llegar acá — este tipo usa el botón/callback existente colacorreo_descartaractivo
      // directamente (ver enviarResumenPendientesDiario), nunca este dispatcher.
      return false;
    case "propuesta_archivo": {
      const p = subId ? await consumirPropuestaClasificacion(subId) : undefined;
      if (p) await unlink(p.rutaLocal).catch(() => {});
      return Boolean(p);
    }
    case "reclasificacion": {
      const p = await consumirPendienteReclasificacionPorChat(chatId);
      if (p) await unlink(p.rutaLocal).catch(() => {});
      return Boolean(p);
    }
    case "captura_empresa": {
      // Hallazgo real de auditoría: eliminarPendienteCapturaEmpresa devuelve void y no-opea en
      // silencio si ya no existe (ej. doble tap del mismo botón) — se verifica antes de borrar para
      // reportar de verdad si había algo que descartar, en vez de "true" siempre.
      const idNumerico = Number(subId);
      if (!subId || !Number.isFinite(idNumerico)) return false;
      const capturas = await obtenerPendientesCapturaEmpresaPorChat(chatId);
      const existe = capturas.some((c) => c.messageId === idNumerico);
      if (!existe) return false;
      await eliminarPendienteCapturaEmpresa(chatId, idNumerico);
      return true;
    }
    case "alerta_documento":
      return Boolean(await consumirPendienteAlertaDocumento(chatId));
    case "correccion_gasto":
      return Boolean(await consumirPendienteCorreccionGasto(chatId));
    case "ajuste_monto_gasto":
      return Boolean(await consumirPendienteAjusteMontoGasto(chatId));
    case "accion_gasto":
      return Boolean(await consumirPendienteAccionGasto(chatId));
    case "seleccion_gasto":
      return Boolean(await consumirPendienteSeleccionGasto(chatId));
    case "desambiguacion": {
      if (!subId) return false;
      const p = await consumirPendienteDesambiguacionPorId(subId, chatId);
      if (p) await unlink(p.rutaLocal).catch(() => {});
      return Boolean(p);
    }
    case "edicion_borrador":
      return Boolean(await consumirPendienteEdicionBorrador(chatId));
    case "monto_pago":
      return Boolean(await consumirPendienteMontoPago(chatId));
    case "orientacion_anotacion":
      return Boolean(await consumirPendienteOrientacionAnotacion(chatId));
    case "orientacion_correo":
      return Boolean(await consumirPendienteOrientacionCorreo(chatId));
    case "regla_clasificacion":
      return Boolean(await consumirPendienteReglaClasificacion(chatId));
  }
}

/** Maneja "🗑️ Descartar #N" del resumen de fin de día — ver descartarUnPendiente. */
export async function handleDescartarItemPendienteCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;

  try {
    await answerCallbackQuery(callback.id);
  } catch (error) {
    console.error("[resumenPendientesDiario] No se pudo responder el callback_query (no crítico):", error);
  }

  if (chatId === undefined) return;

  const [, codigoRaw, subId] = (callback.data ?? "").split(":");
  const tipo = codigoRaw ? TIPO_POR_CODIGO[codigoRaw] : undefined;
  if (!tipo) {
    await sendTelegramMessage(chatId, "No reconozco qué pendiente descartar — puede que el botón esté corrupto.").catch(() => {});
    return;
  }

  try {
    const borrado = await descartarUnPendiente(chatId, tipo, subId ?? "");
    await sendTelegramMessage(
      chatId,
      borrado ? "🗑️ Descartado." : "Ya no estaba pendiente — puede que ya lo hayas resuelto por otro camino."
    ).catch(() => {});
  } catch (error) {
    console.error("[resumenPendientesDiario] Error descartando un pendiente individual (no crítico):", error);
    await sendTelegramMessage(chatId, "Hubo un error descartándolo — puedes intentar de nuevo.").catch(() => {});
  }
}

/** Primera pulsación: explica el alcance y exige confirmación, sin borrar todavía. */
export async function handleDescartarTodoPendienteCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;

  try {
    await answerCallbackQuery(callback.id);
  } catch (error) {
    console.error("[resumenPendientesDiario] No se pudo responder el callback_query (no crítico):", error);
  }

  if (chatId === undefined) return;

  await sendTelegramMessageWithButtons(
    chatId,
    "⚠️ ¿Confirmas que quieres limpiar los pendientes descartables? Las propuestas financieras seguirán intactas y los correos de Gmail permanecerán SIN LEER para que WOBI vuelva a revisarlos.",
    [[
      { text: "✅ Sí, limpiar pendientes", callback_data: "resumen_descartar_todo:confirmar" },
      { text: "↩️ Cancelar", callback_data: "resumen_descartar_todo:cancelar" },
    ]]
  );
}

/** Segunda pulsación explícita: limpia stores locales, pero jamás cambia Gmail. */
export async function handleConfirmarDescartarTodoPendienteCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;

  try {
    await answerCallbackQuery(callback.id);
  } catch (error) {
    console.error("[resumenPendientesDiario] No se pudo responder el callback_query de confirmación (no crítico):", error);
  }

  if (chatId === undefined) return;

  const n = await descartarTodosLosPendientes(chatId);
  await sendTelegramMessage(
    chatId,
    n > 0
      ? `🧹 Limpieza completada — ${n} cosa${n === 1 ? "" : "s"} pendiente${n === 1 ? "" : "s"} menos. Las propuestas financieras no se tocaron y los correos permanecen sin leer en Gmail.`
      : "Ya no quedaba nada pendiente para descartar."
  ).catch(() => {});
}

/** Cancela la confirmación sin cambiar ningún pendiente ni correo. */
export async function handleCancelarDescartarTodoPendienteCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  try {
    await answerCallbackQuery(callback.id, "Limpieza cancelada.");
  } catch (error) {
    console.error("[resumenPendientesDiario] No se pudo responder el callback_query de cancelación (no crítico):", error);
  }
  if (chatId !== undefined) {
    await sendTelegramMessage(chatId, "↩️ Limpieza cancelada — no se modificó ningún pendiente ni correo.").catch(() => {});
  }
}
