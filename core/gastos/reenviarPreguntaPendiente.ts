import { obtenerConciliacionesPendientesPorChat, type ConciliacionPendiente } from "./conciliacionPendienteStore";
import {
  obtenerConciliacionesAmbiguasPendientesPorChat,
  type ConciliacionAmbiguaPendiente,
} from "./conciliacionAmbiguaPendienteStore";
import { obtenerPropuestasGastoPorChat } from "./gastoProposalSheet";
import { obtenerGastosPendienteDatosPorChat, type GastoPendienteDatos } from "./gastoPendienteDatosStore";
import { botonesFalloTemporalVerificacionPendiente } from "./gastoPendienteDatosActions";
import { reenviarPropuestaGasto } from "./reenviarPropuestaGasto";
import { botonContinuarConciliacion } from "./continuarCorreoConciliacion";
import { botonesOfertaParcial, consultarCargoParcial, textoOfertaParcial } from "./conciliacionParcialRecibo";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import { montosCercanos } from "../utils/montos";

/**
 * Vuelve a poner AL FINAL del chat la pregunta que de verdad está esperando respuesta.
 *
 * Caso real (Carlos, 2026-09-28 20:13): la cola quedó parada en «$ 12,50 - Airalo - Revolut», cuyo
 * gasto ya estaba creado y esperaba solo «¿conciliar?». En el chat, lo último visible era una
 * propuesta de otro correo sin botones; Carlos pidió «no me diste la transacción con botones» y
 * Wobi contestó que no tenía nada pendiente: `reenviar_botones_propuesta_gasto` solo miraba las
 * PROPUESTAS de gasto, nunca las preguntas de conciliación (simple o ambigua), y el aviso de fin de
 * revisión decía «los botones siguen arriba en el chat» en vez de volver a mostrarlos.
 *
 * Regla que aplica este módulo, la misma de PR #194: el resultado pendiente siempre al final del
 * chat, con sus botones REALES (los mismos callback_data que el mensaje original, así que las
 * protecciones de acciones sensibles y el consumo único de la decisión se conservan). Nunca crea,
 * concilia ni cancela nada por sí mismo.
 */
export type PreguntaReenviada =
  | { tipo: "propuesta"; descripcion: string }
  | { tipo: "conciliacion"; descripcion: string }
  | { tipo: "conciliacion_ambigua"; descripcion: string }
  | { tipo: "gasto_pendiente_datos"; descripcion: string };

/**
 * Texto de la pregunta que sigue esperando respuesta para un gasto al que le falta un dato (se contesta en texto libre;
 * `reintentar_gasto_pendiente` la consume). Lógica pura, probada aparte.
 *
 * Caso real (Carlos, 2026-10-07): la cola llevaba horas parada en «Lunch - 180 pesos mexicanos - revolut»: el recibo se leyó
 * bien, pero Footprint no tiene cuenta en MXN y Wobi pidió en texto el importe exacto en la moneda real. Esa pregunta quedó
 * enterrada en el chat y el aviso de fin de revisión decía «fallo temporal» porque este reenvío no miraba este almacén.
 */
export function textoPreguntaGastoPendienteDatos(p: GastoPendienteDatos): string {
  const proveedor = p.datos.proveedor?.trim() || "Gasto";
  const importe = `${p.datos.monto} ${p.datos.moneda}`;
  const cierre = "Si no tienes el dato, dime «descarta la pregunta pendiente del gasto» y la cola sigue sin registrar nada.";
  switch (p.motivo) {
    case "empresa":
      return `📄 «${proveedor}» · ${importe}: no tengo clara la empresa. Dime a qué empresa (WOBA, EWORKS o Footprint) pertenece y sigo. ${cierre}`;
    case "moneda":
      return `💱 «${proveedor}» · ${importe}: necesito el monto EXACTO y la moneda que salió de la cuenta real (ej. «40.46 EUR»); no calculo tipos de cambio. Respóndeme aquí en texto libre y sigo. ${cierre}`;
    case "fecha":
      return `🔎 «${proveedor}» · ${importe}: el comprobante no tiene una fecha verificable. Respóndeme con la fecha documentada (AAAA-MM-DD) y sigo. ${cierre}`;
    case "proveedor":
      return `🏷️ ${importe}: no pude leer el proveedor del comprobante. Dime su nombre y sigo. ${cierre}`;
    case "verificacion_duplicado":
      return `⚠️ «${proveedor}» · ${importe}: la verificación de duplicados en Holded quedó pendiente; por seguridad no se propuso ni creó el gasto.`;
  }
}

/** Vuelve a poner al final del chat la pregunta del dato que falta. Nunca crea ni cierra nada. */
export async function reenviarPreguntaGastoPendienteDatos(p: GastoPendienteDatos, encabezado: string): Promise<void> {
  const texto = `${encabezado}\n\n${textoPreguntaGastoPendienteDatos(p)}`;
  // El fallo de verificación se retoma con sus botones acotados (reintentar/aplazar); un fallo técnico nunca se «confirma».
  if (p.motivo === "verificacion_duplicado") {
    await sendTelegramMessageWithButtons(p.chatId, texto, botonesFalloTemporalVerificacionPendiente(p.id));
  } else {
    await sendTelegramMessage(p.chatId, texto);
  }
}

export async function reenviarPreguntaConciliacion(p: ConciliacionPendiente, encabezado: string): Promise<number> {
  // Si el banco tiene UN único cargo del proveedor menor que el gasto (recibo cobrado en varios pagos), el reenvío ya trae el botón de la parte.
  const datos = { empresa: p.empresa, proveedor: p.proveedor ?? "", monto: p.monto, moneda: p.moneda ?? "EUR", fecha: p.fecha };
  const consulta = await consultarCargoParcial(datos);
  const oferta = consulta.tipo === "oferta" ? consulta.cargo : undefined;
  const botones = oferta
    ? [...botonesOfertaParcial(p.id, oferta, datos), ...botonContinuarConciliacion(p)]
    : [[
        { text: "🔗 Sí, conciliar", callback_data: `gasto_conciliar_si:${p.id}` },
        { text: "❌ No, dejar así", callback_data: `gasto_conciliar_no:${p.id}` },
      ], ...botonContinuarConciliacion(p)];
  const base = `${encabezado}\n\n🔗 El gasto «${p.descripcionGasto}» ya está creado en Holded. `;
  const texto = oferta
    ? `${base}\n\n${textoOfertaParcial(oferta, datos, p.descripcionGasto)}`
    : `${base}¿Quieres que intente conciliarlo con el cargo bancario?` +
      (consulta.tipo === "consulta_fallida" ? "\n\n⚠️ No pude consultar ahora el banco para ver si hay una parte de este recibo ya cobrada." : "");
  return sendTelegramMessageWithButtons(p.chatId, texto, botones);
}

export async function reenviarPreguntaConciliacionAmbigua(p: ConciliacionAmbiguaPendiente, encabezado: string): Promise<number> {
  const botones = [
    ...p.candidatos.map((c, i) => [{
      text: `${i + 1}. ${c.descripcion || "sin descripción"} — ${c.monto.toFixed(2)} ${c.moneda} (${c.fecha})`,
      callback_data: `gasto_conciliar_elegir:${p.id}:${i}`,
    }]),
    [{ text: "❌ Ninguno / no conciliar", callback_data: `gasto_conciliar_elegir_no:${p.id}` }],
    ...botonContinuarConciliacion(p, true),
  ];
  const texto =
    `${encabezado}\n\n🔗 El gasto «${p.descripcionGasto}» ya está creado en Holded y hay varios cargos bancarios posibles. ` +
    `Elige el que corresponde:`;
  return sendTelegramMessageWithButtons(p.chatId, texto, botones);
}

const coincideCorreo = (
  origen: { mensajeIdGmail?: string; threadId?: string } | undefined,
  mensajeId: string,
  threadId: string
): boolean => Boolean(origen && (origen.mensajeIdGmail === mensajeId || origen.threadId === threadId));

/**
 * Para el correo ACTIVO de la cola: busca su decisión pendiente en los tres almacenes donde puede
 * vivir y la reenvía con botones. undefined = no hay ninguna decisión pendiente para ese correo
 * (entonces sí procede «Reprocesar este correo»).
 */
export async function reenviarPreguntaPendienteDelCorreo(
  chatId: number,
  mensajeId: string,
  threadId: string,
  encabezado: string
): Promise<PreguntaReenviada | undefined> {
  const propuesta = (await obtenerPropuestasGastoPorChat(chatId)).find((p) =>
    coincideCorreo(p.correoOrigen, mensajeId, threadId)
  );
  if (propuesta) {
    await reenviarPropuestaGasto(propuesta, encabezado);
    return { tipo: "propuesta", descripcion: `${propuesta.proveedor} — ${propuesta.monto.toFixed(2)} ${propuesta.moneda}` };
  }
  const conciliacion = (await obtenerConciliacionesPendientesPorChat(chatId)).find((c) =>
    coincideCorreo({ mensajeIdGmail: c.mensajeIdGmail, threadId: c.threadIdGmail }, mensajeId, threadId)
  );
  if (conciliacion) {
    await reenviarPreguntaConciliacion(conciliacion, encabezado);
    return { tipo: "conciliacion", descripcion: conciliacion.descripcionGasto };
  }
  const ambigua = (await obtenerConciliacionesAmbiguasPendientesPorChat(chatId)).find((c) =>
    coincideCorreo({ mensajeIdGmail: c.mensajeIdGmail, threadId: c.threadIdGmail }, mensajeId, threadId)
  );
  if (ambigua) {
    await reenviarPreguntaConciliacionAmbigua(ambigua, encabezado);
    return { tipo: "conciliacion_ambigua", descripcion: ambigua.descripcionGasto };
  }
  // Cuarto almacén (caso Lunch 180 MXN): un gasto leído al que le falta un dato que se responde en texto libre.
  const pendienteDatos = (await obtenerGastosPendienteDatosPorChat(chatId)).find((g) =>
    coincideCorreo({ mensajeIdGmail: g.correoOrigen?.mensajeIdGmail, threadId: g.correoOrigen?.threadId }, mensajeId, threadId)
  );
  if (pendienteDatos) {
    await reenviarPreguntaGastoPendienteDatos(pendienteDatos, encabezado);
    return { tipo: "gasto_pendiente_datos", descripcion: `${pendienteDatos.datos.proveedor || "gasto"} — ${pendienteDatos.datos.monto} ${pendienteDatos.datos.moneda}` };
  }
  return undefined;
}

/**
 * Para el chat conversacional («no me diste los botones de X»): las preguntas de conciliación
 * pendientes del chat que coinciden con lo que el usuario nombró (proveedor, parte del nombre,
 * descripción, monto). Sin `cual`, todas. Lógica pura, probada aparte.
 */
/**
 * Texto de búsqueda de /preguntas sin acentos ni puntuación: «casa peppe.» (con el punto de la frase, como lo escribió Carlos el
 * 2026-10-06) encuentra «Casa Peppe (Il Gusto S.A.S.)». Las palabras se separan por un solo espacio.
 */
export function normalizarBusqueda(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** «142,48.» → 142.48 (ignora la puntuación final de la frase); NaN si no es un importe. */
export function importeDeBusqueda(texto: string): number {
  return Number(texto.trim().replace(/[.,;:!?)\s]+$/, "").replace(/[^\d.,]/g, "").replace(",", "."));
}

export function filtrarConciliacionesPorTexto<T extends { descripcionGasto: string; proveedor?: string; monto?: number }>(
  pendientes: T[],
  cual: string
): T[] {
  const texto = normalizarBusqueda(cual);
  if (!texto) return cual.trim() ? [] : pendientes;
  const porNombre = pendientes.filter((p) => {
    const nombre = normalizarBusqueda(`${p.proveedor ?? ""} ${p.descripcionGasto}`);
    const proveedor = p.proveedor?.trim() ? normalizarBusqueda(p.proveedor) : "";
    return nombre.includes(texto) || (proveedor ? texto.includes(proveedor) : false);
  });
  if (porNombre.length > 0) return porNombre;
  const comoMonto = importeDeBusqueda(cual);
  if (Number.isFinite(comoMonto) && comoMonto > 0) {
    const porMonto = pendientes.filter((p) => p.monto !== undefined && montosCercanos(p.monto, comoMonto, 0.01));
    if (porMonto.length > 0) return porMonto;
  }
  return [];
}
