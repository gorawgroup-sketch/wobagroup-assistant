import type { Empresa } from "../client";
import { claveMovimiento, esDivisaExtranjera, importe, TTL_PLAN, validarSeleccion, type CompraExacta, type MovimientoExacto, type PlanConciliacion, type ReferenciaMovimiento } from "../conciliacionMultiple/model";

/**
 * Lote de conciliaciones: VARIOS pares «un gasto ↔ un cargo» ya identificados, aprobados con UN solo botón (caso de Carlos,
 * auditoría de Footprint, 16-10-2026: 17 parejas demostradas y ninguna ganas de pulsar 17 mensajes).
 *
 * No añade una vía nueva de escritura: cada par es un plan del motor de conciliación múltiple (core/holded/conciliacionMultiple/),
 * que relee Holded, reserva compra y cargo, persiste el paso en vuelo antes de cada POST y verifica el pago y los saldos al céntimo.
 * El lote solo decide QUÉ pares entran, los revalida todos antes de escribir el primero y los ejecuta de uno en uno, deteniéndose
 * en el primero que no se pueda verificar. Alcance de esta versión: gasto y cargo en EUR con importe exacto (el resto se excluye
 * con su motivo y sigue el camino individual).
 */
export const MAX_PARES_LOTE = 20;
/** Un lote propuesto caduca igual que sus planes. */
export const TTL_LOTE = TTL_PLAN;

export interface ParSolicitado { compraId: string; accountId: string; movementId: string; fecha: string }
export interface ParIncluido { compraId: string; planId: string; proveedor: string; numero: string; fechaCompra: string; importeCentimos: number; moneda: string; movimiento: string; fechaMovimiento: string; descripcion: string; cuenta: string }
export interface ParExcluido { compraId: string; movimiento: string; motivo: string }
export type EstadoLote = "propuesto" | "ejecutando" | "completado" | "parcial" | "cancelado" | "rechazado" | "incierto";
export interface ResultadoPar { planId: string; estado: PlanConciliacion["estado"] | "no_ejecutado"; detalle: string }
export interface LoteConciliaciones {
  id: string;
  empresa: Empresa;
  chatId: number;
  creadoEn: number;
  motivo: string;
  estado: EstadoLote;
  incluidos: ParIncluido[];
  excluidos: ParExcluido[];
  resultados: ResultadoPar[];
  aprobadoPor?: number;
  detalle?: string;
}

const ID_HOLDED = /^[a-zA-Z0-9_-]{1,100}$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Forma de la entrada: nada se lee de Holded hasta que esto pasa. Un mismo gasto o un mismo cargo no puede aparecer dos veces. */
export function validarEntradaLote(pares: ParSolicitado[], motivo: string): void {
  if (!Array.isArray(pares) || pares.length < 1 || pares.length > MAX_PARES_LOTE) throw new Error(`Un lote lleva de 1 a ${MAX_PARES_LOTE} pares.`);
  if (!motivo?.trim() || motivo.length > 500) throw new Error("Indica la evidencia que vincula estos pares (hasta 500 caracteres).");
  const compras = new Set<string>(), cargos = new Set<string>();
  for (const p of pares) {
    if (!ID_HOLDED.test(p.compraId ?? "") || !ID_HOLDED.test(p.accountId ?? "") || !ID_HOLDED.test(p.movementId ?? "") || !FECHA.test(p.fecha ?? "")) {
      throw new Error("Cada par necesita compra_id, cuenta_id y movimiento_id reales de Holded y la fecha bancaria YYYY-MM-DD.");
    }
    if (compras.has(p.compraId)) throw new Error(`El gasto ${p.compraId} aparece dos veces en el lote.`);
    if (cargos.has(`${p.accountId}/${p.movementId}`)) throw new Error(`El cargo ${p.accountId}/${p.movementId} aparece dos veces en el lote.`);
    compras.add(p.compraId); cargos.add(`${p.accountId}/${p.movementId}`);
  }
}

/**
 * ¿Este par entra en el lote? Devuelve el motivo exacto cuando no. Mismas pruebas que el motor aplicará al ejecutar (validarSeleccion), más
 * los rechazos explicados de lo que el lote no cubre todavía: así el operador ve al proponer por qué un par queda fuera y no a mitad de la ejecución.
 */
export function motivoDeExclusion(compra: CompraExacta, movimiento: MovimientoExacto): string | undefined {
  if (esDivisaExtranjera(compra) || movimiento.moneda !== "EUR") {
    return "el gasto o el cargo están en otra moneda: Holded exige ajustar la tasa de cambio del gasto antes de conciliar y esa edición no se hace dentro de un lote (concílialo por su botón individual).";
  }
  if (compra.pagos.length > 0) return "el gasto ya tiene pagos: no se le añade otro cargo dentro de un lote.";
  if (movimiento.centimos < 0 && -movimiento.centimos > compra.pendienteCentimos) {
    return `el cargo (${importe(-movimiento.centimos)} ${movimiento.moneda}) es MAYOR que el saldo del gasto (${importe(compra.pendienteCentimos)}): sería un cargo mayor con comisión, que no entra en el lote.`;
  }
  try { validarSeleccion(compra, [movimiento], { unico: true }); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return undefined;
}

/** El lote reserva mientras no esté en un estado final; sirve para no proponer el mismo par dos veces a la vez. */
export function loteVigente(l: LoteConciliaciones, ahora = Date.now()): boolean {
  if (l.estado === "cancelado" || l.estado === "rechazado" || l.estado === "completado") return false;
  return l.estado !== "propuesto" || ahora - l.creadoEn <= TTL_LOTE;
}

/** Importe del par: el saldo que se concilia (en este alcance, igual al total del gasto y al del cargo). */
export const importeDe = (c: CompraExacta): number => c.pendienteCentimos;
/**
 * Cargos que un lote todavía reserva. Propuesto o ejecutando: todos. Detenido (parcial/incierto): solo los pares cuyo resultado sigue incierto;
 * los pares no enviados tienen su plan cancelado y pueden volver a proponerse, y los conciliados ya no se pueden reutilizar.
 */
export function clavesBloqueadas(l: LoteConciliaciones): string[] {
  if (l.estado === "propuesto" || l.estado === "ejecutando") return l.incluidos.map((p) => p.movimiento);
  const inciertos = new Set(l.resultados.filter((r) => r.estado === "incierto" || r.estado === "ejecutando").map((r) => r.planId));
  return l.incluidos.filter((p) => inciertos.has(p.planId)).map((p) => p.movimiento);
}
/** Los pares pedidos (incluidos + excluidos) que un lote ya propuesto representa: sirve para reconocer la MISMA petición aunque algún par quedara fuera. */
export const huellaDePeticion = (l: LoteConciliaciones): string =>
  [...l.incluidos.map((p) => `${p.compraId}|${p.movimiento}`), ...l.excluidos.map((x) => `${x.compraId}|${x.movimiento}`)].sort().join(",");
export const referenciaDePar = (p: ParIncluido): ReferenciaMovimiento => {
  const [accountId, movementId] = p.movimiento.split("/");
  return { accountId, movementId, fecha: p.fechaMovimiento };
};
export { claveMovimiento };

const linea = (p: ParIncluido, i: number): string =>
  `${i + 1}. ${p.proveedor} — ${importe(p.importeCentimos)} ${p.moneda} (gasto ${p.numero || "sin número"}, ${p.fechaCompra})\n   ↔ ${p.fechaMovimiento} · ${p.cuenta} · «${p.descripcion}»\n   [gasto ${p.compraId}] [${p.movimiento}]`;

export function resumenLote(l: LoteConciliaciones): string {
  const total = l.incluidos.reduce((t, p) => t + p.importeCentimos, 0);
  return `Lote de conciliaciones — ${l.empresa}\n${l.incluidos.length} par(es), importes exactos al céntimo, suman ${importe(total)} EUR.\n\n` +
    l.incluidos.map(linea).join("\n") +
    (l.excluidos.length ? `\n\nNO entran en el lote (${l.excluidos.length}):\n${l.excluidos.map((x) => `• ${x.compraId} ↔ ${x.movimiento}: ${x.motivo}`).join("\n")}` : "") +
    `\n\nEvidencia: ${l.motivo}\nLote: ${l.id}`;
}

export function estadoLote(l: LoteConciliaciones): string {
  const hechos = l.resultados.filter((r) => r.estado === "completado").length;
  const icono = l.estado === "completado" ? "✅" : l.estado === "incierto" || l.estado === "parcial" || l.estado === "ejecutando" ? "⚠️" : "ℹ️";
  const enCurso = l.estado === "ejecutando"
    ? "El lote está en curso o se interrumpió: puede haber pagos ya aplicados que este recuento aún no refleja. No repetir ni dar por resuelto: revisa sus planes y Holded.\n" : "";
  return `${icono} Lote ${l.id}: ${l.estado}.\nPares conciliados y verificados en Holded: ${hechos}/${l.incluidos.length}.\n${enCurso}` +
    (l.resultados.length ? `${l.resultados.map((r, i) => `${r.estado === "completado" ? "✅" : r.estado === "no_ejecutado" ? "⏸" : "⚠️"} ${i + 1}. ${l.incluidos.find((p) => p.planId === r.planId)?.proveedor ?? r.planId}: ${r.detalle}`).join("\n")}\n` : "") +
    (l.detalle ?? (l.estado === "propuesto" ? "Pendiente de aprobación; todavía no se ha conciliado nada." : "")) +
    (l.estado === "incierto" ? "\nNo repetir ni dar por resuelto: revisar el plan indicado y Holded antes de cualquier nueva operación." : "");
}
