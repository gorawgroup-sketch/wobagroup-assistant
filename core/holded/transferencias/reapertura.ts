import type { Empresa } from "../client";
import type { PropuestaTransferencia } from "./deteccion";
import type { RegistroTransferencia } from "./registro";

/**
 * Qué hacer con el registro de una pareja cuando se vuelve a detectar.
 *
 * Una pareja se registra como «ambigua» cuando se publica bloqueada. Si la detección mejora (caso real Footprint 08-10-2026: cuatro
 * parejas bloqueadas que eran dos conversiones claras más dos cruces absurdos), la pareja que ya NO está bloqueada tiene que poder
 * proponerse con su botón de conciliar; antes «ambigua» contaba como cerrada para siempre.
 */
export const ESTADOS_SIN_REPROPONER: ReadonlyArray<RegistroTransferencia["estado"]> =
  ["propuesta", "ambigua", "aprobada", "ejecutando", "verificada", "fallida", "descartada", "revision_manual"];

export type DecisionRegistro = "publicar" | "ya_publicada" | "reabrir";

export function decidirPublicacion(actual: RegistroTransferencia | undefined, p: PropuestaTransferencia): DecisionRegistro {
  if (!actual || !ESTADOS_SIN_REPROPONER.includes(actual.estado)) return "publicar";
  if (actual.estado === "ambigua" && p.confianza !== "bloqueada") return "reabrir";
  return "ya_publicada";
}

/**
 * Registros «ambigua» de una empresa que la detección actual ya no devuelve (cruces absurdos, o movimientos ya conciliados a mano):
 * su mensaje solo ofrece saltar o revisar y ya no corresponde a nada. Solo se retiran las «ambigua»: nunca una propuesta viva ni una
 * operación con decisión o resultado.
 */
export function registrosObsoletos(registros: RegistroTransferencia[], empresa: Empresa, vigentes: PropuestaTransferencia[]): RegistroTransferencia[] {
  const claves = new Set(vigentes.map((p) => p.clave));
  return registros.filter((r) => r.empresa === empresa && r.estado === "ambigua" && !claves.has(r.clave));
}
