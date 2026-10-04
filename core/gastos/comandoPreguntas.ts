import { obtenerConciliacionesPendientesPorChat, type ConciliacionPendiente } from "./conciliacionPendienteStore";
import { obtenerConciliacionesAmbiguasPendientesPorChat, type ConciliacionAmbiguaPendiente } from "./conciliacionAmbiguaPendienteStore";
import { obtenerPropuestasGastoPorChat, type PropuestaGasto } from "./gastoProposalSheet";
import { reenviarPropuestaGasto } from "./reenviarPropuestaGasto";
import { filtrarConciliacionesPorTexto, reenviarPreguntaConciliacion, reenviarPreguntaConciliacionAmbigua } from "./reenviarPreguntaPendiente";
import { montosCercanos } from "../utils/montos";

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
  const t = cual.trim().toLowerCase();
  if (!t) return propuestas;
  const porNombre = propuestas.filter((p) => `${p.proveedor} ${p.concepto ?? ""}`.toLowerCase().includes(t));
  if (porNombre.length > 0) return porNombre;
  const monto = Number(t.replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(monto) && monto > 0 ? propuestas.filter((p) => montosCercanos(p.monto, monto, 0.01)) : [];
}

export async function ejecutarComandoPreguntas(chatId: number, cual: string, deps: DependenciasComandoPreguntas = depsReales): Promise<string> {
  const [todasP, todasS, todasA] = await Promise.all([deps.propuestas(chatId), deps.simples(chatId), deps.ambiguas(chatId)]);
  const items = [
    ...propuestasPorTexto(todasP, cual).map((p) => ({ descripcion: `Propuesta de gasto: ${p.proveedor} — ${p.monto.toFixed(2)} ${p.moneda}`, enviar: () => deps.reenviarPropuesta(p) })),
    ...filtrarConciliacionesPorTexto(todasS, cual).map((p) => ({ descripcion: `Conciliar: ${p.descripcionGasto}`, enviar: () => deps.reenviarSimple(p) })),
    ...filtrarConciliacionesPorTexto(todasA, cual).map((p) => ({ descripcion: `Elegir cargo: ${p.descripcionGasto}`, enviar: () => deps.reenviarAmbigua(p) })),
  ];
  if (items.length === 1) {
    await items[0].enviar();
    return `🔁 Reenvié al final del chat: ${items[0].descripcion}. Toca el botón que corresponda (esto no creó ni concilió nada).`;
  }
  if (items.length === 0) {
    const hay = todasP.length + todasS.length + todasA.length;
    return cual
      ? `No encuentro ninguna pregunta pendiente que coincida con «${cual}».${hay > 0 ? ` Hay ${hay} pendientes: escribe /preguntas sin texto para verlas.` : ""}`
      : "No hay ninguna propuesta de gasto ni pregunta de conciliación pendiente en este chat.";
  }
  return `Hay ${items.length} pendientes${cual ? ` que coinciden con «${cual}»` : ""}:\n` +
    items.map((i, k) => `${k + 1}. ${i.descripcion}`).join("\n") +
    "\n\nEscribe /preguntas seguido de una parte del nombre o el monto (ej. /preguntas metro) para reenviar solo esa.";
}
