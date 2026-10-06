import { obtenerConciliacionesPendientesPorChat, type ConciliacionPendiente } from "./conciliacionPendienteStore";
import { obtenerConciliacionesAmbiguasPendientesPorChat, type ConciliacionAmbiguaPendiente } from "./conciliacionAmbiguaPendienteStore";
import { obtenerPropuestasGastoPorChat, type PropuestaGasto } from "./gastoProposalSheet";
import { reenviarPropuestaGasto } from "./reenviarPropuestaGasto";
import { filtrarConciliacionesPorTexto, importeDeBusqueda, normalizarBusqueda, reenviarPreguntaConciliacion, reenviarPreguntaConciliacionAmbigua } from "./reenviarPreguntaPendiente";
import { montosCercanos } from "../utils/montos";
import { answerCallbackQuery } from "../telegram/client";
import type { InlineKeyboardButton, TelegramCallbackQuery } from "../telegram/types";

/**
 * Comando fijo `/preguntas [texto]` (pedido de Carlos, 2026-10-04, Metroart): vuelve a poner al FINAL del chat la pregunta o
 * propuesta de gasto que sigue esperando una decisión, con sus botones reales. Es lo mismo que hace la herramienta
 * `reenviar_botones_propuesta_gasto`, pero SIN pasar por el modelo: ese día WOBI contestó «no hay nada que reenviar» de memoria,
 * sin llamar a ninguna herramienta, con la pregunta viva en el registro. Aquí lo decide el servidor. Nunca crea, concilia ni
 * cancela nada: solo reenvía botones (las acciones siguen protegidas por el router de callbacks, solo superadministrador).
 */
export interface DependenciasComandoPreguntas {
  propuestas(chatId: number): Promise<PropuestaGasto[]>;
  simples(chatId: number): Promise<ConciliacionPendiente[]>;
  ambiguas(chatId: number): Promise<ConciliacionAmbiguaPendiente[]>;
  reenviarPropuesta(p: PropuestaGasto): Promise<unknown>;
  reenviarSimple(p: ConciliacionPendiente): Promise<unknown>;
  reenviarAmbigua(p: ConciliacionAmbiguaPendiente): Promise<unknown>;
}

const ENCABEZADO = "🔁 Pregunta pendiente renovada — toca la decisión que quieras aplicar.";
const depsReales: DependenciasComandoPreguntas = {
  propuestas: obtenerPropuestasGastoPorChat,
  simples: obtenerConciliacionesPendientesPorChat,
  ambiguas: obtenerConciliacionesAmbiguasPendientesPorChat,
  reenviarPropuesta: (p) => reenviarPropuestaGasto(p, "🔁 Botones renovados — toca la decisión que quieras aplicar."),
  reenviarSimple: (p) => reenviarPreguntaConciliacion(p, ENCABEZADO),
  reenviarAmbigua: (p) => reenviarPreguntaConciliacionAmbigua(p, ENCABEZADO),
};

/**
 * `/preguntas`, `/preguntas metro` o la frase «preguntas pendientes [texto]» → el texto tras la orden ("" si no hay). undefined si no es
 * la orden. Sin barra solo vale la frase completa: una palabra suelta («pendientes de hoy») es conversación normal y va al modelo.
 */
export function parsearComandoPreguntas(texto: string): string | undefined {
  const m = /^\s*(?:\/preguntas\b(?!\w)|preguntas\s+pendientes\b)\s*(.*)$/is.exec(texto.trim());
  return m ? m[1].trim() : undefined;
}

function propuestasPorTexto(propuestas: PropuestaGasto[], cual: string): PropuestaGasto[] {
  const t = normalizarBusqueda(cual);
  if (!t) return cual.trim() ? [] : propuestas;
  const porNombre = propuestas.filter((p) => normalizarBusqueda(`${p.proveedor} ${p.concepto ?? ""}`).includes(t));
  if (porNombre.length > 0) return porNombre;
  const monto = importeDeBusqueda(cual);
  return Number.isFinite(monto) && monto > 0 ? propuestas.filter((p) => montosCercanos(p.monto, monto, 0.01)) : [];
}

export interface RespuestaPreguntas {
  texto: string;
  /** Con varias pendientes: un botón por cada una (reenvía esa con sus botones) y uno para empezar por la primera. */
  botones?: InlineKeyboardButton[][];
}

interface ItemPendiente {
  /** «p:ID» propuesta de gasto · «s:ID» conciliar · «a:ID» elegir cargo: identifica la pendiente en el botón. */
  clave: string;
  icono: string;
  descripcion: string;
  etiqueta: string;
  enviar: () => Promise<unknown>;
}

const recortar = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function listarPendientes(todasP: PropuestaGasto[], todasS: ConciliacionPendiente[], todasA: ConciliacionAmbiguaPendiente[], cual: string, deps: DependenciasComandoPreguntas): ItemPendiente[] {
  return [
    ...propuestasPorTexto(todasP, cual).map((p) => ({ clave: `p:${p.id}`, icono: "🧾", descripcion: `Propuesta de gasto: ${p.proveedor} — ${p.monto.toFixed(2)} ${p.moneda}`, etiqueta: `${p.proveedor} ${p.monto.toFixed(2)} ${p.moneda}`, enviar: () => deps.reenviarPropuesta(p) })),
    ...filtrarConciliacionesPorTexto(todasS, cual).map((p) => ({ clave: `s:${p.id}`, icono: "🔗", descripcion: `Conciliar: ${p.descripcionGasto}`, etiqueta: p.descripcionGasto, enviar: () => deps.reenviarSimple(p) })),
    ...filtrarConciliacionesPorTexto(todasA, cual).map((p) => ({ clave: `a:${p.id}`, icono: "🎯", descripcion: `Elegir cargo: ${p.descripcionGasto}`, etiqueta: p.descripcionGasto, enviar: () => deps.reenviarAmbigua(p) })),
  ];
}

export async function ejecutarComandoPreguntas(chatId: number, cual: string, deps: DependenciasComandoPreguntas = depsReales): Promise<RespuestaPreguntas> {
  const [todasP, todasS, todasA] = await Promise.all([deps.propuestas(chatId), deps.simples(chatId), deps.ambiguas(chatId)]);
  const items = listarPendientes(todasP, todasS, todasA, cual, deps);
  if (items.length === 1) {
    await items[0].enviar();
    return { texto: `🔁 Reenvié al final del chat: ${items[0].descripcion}. Toca el botón que corresponda (esto no creó ni concilió nada).` };
  }
  if (items.length === 0) {
    const hay = todasP.length + todasS.length + todasA.length;
    return { texto: cual
      ? `No encuentro ninguna pregunta pendiente que coincida con «${cual}».${hay > 0 ? ` Hay ${hay} pendientes: escribe /preguntas sin texto para verlas.` : ""}`
      : "No hay ninguna propuesta de gasto ni pregunta de conciliación pendiente en este chat." };
  }
  return {
    texto: `Hay ${items.length} pendientes${cual ? ` que coinciden con «${cual}»` : ""}:\n` +
      items.map((i, k) => `${k + 1}. ${i.descripcion}`).join("\n") +
      "\n\n👇 Toca una para gestionarla: te la reenvío abajo con sus botones. También puedes escribir /preguntas seguido de una parte del nombre o el monto (ej. /preguntas metro).",
    botones: [
      [{ text: "▶ Empezar por la primera", callback_data: "preg_r:primera" }],
      ...items.map((i, k) => [{ text: `${i.icono} ${k + 1}. ${recortar(i.etiqueta, 42)}`, callback_data: `preg_r:${i.clave}` }]),
    ],
  };
}

/** Botones de la lista de /preguntas: reenvía UNA pendiente con sus botones reales (nunca crea, concilia ni cancela nada). */
export async function handleReenviarPreguntaCallback(callback: TelegramCallbackQuery, deps: DependenciasComandoPreguntas = depsReales): Promise<void> {
  const chatId = callback.message?.chat.id;
  const clave = (callback.data ?? "").replace(/^preg_r:/, "");
  const responder = async (t?: string) => { try { await answerCallbackQuery(callback.id, t); } catch (error) { console.error("[preguntas] No se pudo responder al botón (no crítico):", error instanceof Error ? error.message : error); } };
  if (!chatId || !clave) { await responder("Petición no válida."); return; }
  const [todasP, todasS, todasA] = await Promise.all([deps.propuestas(chatId), deps.simples(chatId), deps.ambiguas(chatId)]);
  const items = listarPendientes(todasP, todasS, todasA, "", deps);
  const item = clave === "primera" ? items[0] : items.find((i) => i.clave === clave);
  if (!item) { await responder(items.length ? "Esa ya no está pendiente. Escribe /preguntas para ver las que quedan." : "No queda nada pendiente."); return; }
  await responder("Te la reenvío abajo ↓");
  await item.enviar();
}
