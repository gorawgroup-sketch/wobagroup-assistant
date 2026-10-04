import { obtenerConciliacionesPendientesPorChat, type ConciliacionPendiente } from "./conciliacionPendienteStore";
import {
  obtenerConciliacionesAmbiguasPendientesPorChat,
  type ConciliacionAmbiguaPendiente,
} from "./conciliacionAmbiguaPendienteStore";
import { obtenerPropuestasGastoPorChat } from "./gastoProposalSheet";
import { reenviarPropuestaGasto } from "./reenviarPropuestaGasto";
import { botonContinuarConciliacion } from "./continuarCorreoConciliacion";
import { botonesOfertaParcial, consultarCargoParcial, textoOfertaParcial } from "./conciliacionParcialRecibo";
import { sendTelegramMessageWithButtons } from "../telegram/client";
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
  | { tipo: "conciliacion_ambigua"; descripcion: string };

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
  return undefined;
}

/**
 * Para el chat conversacional («no me diste los botones de X»): las preguntas de conciliación
 * pendientes del chat que coinciden con lo que el usuario nombró (proveedor, parte del nombre,
 * descripción, monto). Sin `cual`, todas. Lógica pura, probada aparte.
 */
export function filtrarConciliacionesPorTexto<T extends { descripcionGasto: string; proveedor?: string; monto?: number }>(
  pendientes: T[],
  cual: string
): T[] {
  const texto = cual.trim().toLowerCase();
  if (!texto) return pendientes;
  const porNombre = pendientes.filter((p) => {
    const nombre = `${p.proveedor ?? ""} ${p.descripcionGasto}`.toLowerCase();
    return nombre.includes(texto) || (p.proveedor?.trim() ? texto.includes(p.proveedor.toLowerCase()) : false);
  });
  if (porNombre.length > 0) return porNombre;
  const comoMonto = Number(texto.replace(/[^\d.,]/g, "").replace(",", "."));
  if (Number.isFinite(comoMonto) && comoMonto > 0) {
    const porMonto = pendientes.filter((p) => p.monto !== undefined && montosCercanos(p.monto, comoMonto, 0.01));
    if (porMonto.length > 0) return porMonto;
  }
  return [];
}
