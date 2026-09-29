import type { PolizaConFila } from "./polizaRegistroSheet";

/**
 * Umbral de "próxima a renovar" — compartido por la tarjeta de Cerebro
 * (core/cerebro/estadoAgregado.ts) y la tool de consulta por chat
 * (core/tools/consultarPolizasSeguro.ts), para que ambos caminos avisen
 * exactamente lo mismo. Antes vivía solo dentro de estadoAgregado.ts;
 * se extrajo acá cuando la tool de chat necesitó el mismo cálculo — un
 * único lugar, nunca dos copias que puedan desalinearse con el tiempo
 * (ver CLAUDE.md, "nuevo almacén persistente" / evitar duplicar lógica).
 */
export const DIAS_ALERTA_VENCIMIENTO_POLIZA = 30;

export interface PolizaProximaARenovar {
  id: string;
  empresa: string;
  tipoCobertura: string;
  aseguradora: string;
  numeroPoliza: string;
  fechaVencimiento: string;
  diasRestantes: number;
}

export interface PolizaPagoSinConfirmar {
  id: string;
  empresa: string;
  tipoCobertura: string;
  aseguradora: string;
  prima: string;
  moneda: string;
  estadoPago: string;
  notas: string;
}

export interface AlertasSeguros {
  proximasARenovar: PolizaProximaARenovar[];
  pagosSinConfirmar: PolizaPagoSinConfirmar[];
}

/** Puro — sin I/O. Recibe las pólizas ya leídas (Sheet o memoria) y calcula qué necesita atención ahora. */
export function calcularAlertasSeguros(polizas: PolizaConFila[], hoy: Date = new Date()): AlertasSeguros {
  // Hallazgo real (2026-09-29, probando esto en vivo con consultar_polizas_seguro): "vencida" es un
  // estado TERMINAL — se marca a propósito cuando un ciclo ya terminó y fue reemplazado por una fila
  // nueva (ej. woba_showroom_allianz, superada por su propio suplemento del ciclo siguiente). Antes solo
  // se excluía "no_contratada", así que una póliza ya marcada vencida seguía apareciendo para siempre
  // como "vence en -29 días" — confuso, no accionable. Una póliza que sigue en "vigente" con la fecha ya
  // pasada SÍ debe seguir alertando (nadie confirmó todavía que se renovó); solo la que ya se marcó
  // "vencida" a mano deja de sonar.
  const conDiasRestantes = polizas
    .filter((p) => p.estado !== "no_contratada" && p.estado !== "vencida" && p.fechaVencimiento)
    .map((p) => ({
      ...p,
      diasRestantes: Math.round((new Date(p.fechaVencimiento).getTime() - hoy.getTime()) / 86400000),
    }));

  const proximasARenovar: PolizaProximaARenovar[] = conDiasRestantes
    .filter((p) => p.diasRestantes <= DIAS_ALERTA_VENCIMIENTO_POLIZA)
    .sort((a, b) => a.diasRestantes - b.diasRestantes)
    .map((p) => ({
      id: p.id,
      empresa: p.empresa,
      tipoCobertura: p.tipoCobertura,
      aseguradora: p.aseguradora,
      numeroPoliza: p.numeroPoliza,
      fechaVencimiento: p.fechaVencimiento,
      diasRestantes: p.diasRestantes,
    }));

  const pagosSinConfirmar: PolizaPagoSinConfirmar[] = polizas
    .filter((p) => p.estadoPago === "pendiente" || p.estadoPago === "sin_confirmar")
    .map((p) => ({
      id: p.id,
      empresa: p.empresa,
      tipoCobertura: p.tipoCobertura,
      aseguradora: p.aseguradora,
      prima: p.prima,
      moneda: p.moneda,
      estadoPago: p.estadoPago,
      notas: p.notas,
    }));

  return { proximasARenovar, pagosSinConfirmar };
}
