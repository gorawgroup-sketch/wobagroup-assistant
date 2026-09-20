import { randomUUID } from "node:crypto";
import { obtenerConsumoActualApi } from "../claude/costTracking";

export type ModoPoliticaApi = "observe" | "disabled" | "allowlist";

export interface ConfiguracionPoliticaApi {
  modo: ModoPoliticaApi;
  killSwitch: boolean;
  procesosPermitidos: Set<string>;
  umbralAlertaDiariaUSD: number;
  limiteDiarioUSD: number;
  limiteMensualUSD: number;
  limitesDiariosPorProceso: Map<string, number>;
}

export interface EstadoConsumoApi {
  gastoDiarioUSD: number;
  gastoMensualUSD: number;
  gastoDiarioProcesoUSD?: number;
}

export interface DecisionPoliticaApi {
  permitida: boolean;
  motivo: string;
  soloObservacion: boolean;
}

export interface EjecucionIA {
  id: string;
  proceso: string;
  /** Se marca ANTES de invocar cualquier herramienta con posibles escrituras. */
  efectosIniciados?: boolean;
  siguienteLlamada(): number;
}

function numeroNoNegativo(raw: string | undefined): number {
  if (!raw?.trim()) return 0;
  const valor = Number(raw);
  return Number.isFinite(valor) && valor >= 0 ? valor : 0;
}

function limitesDiariosPorProceso(raw: string | undefined): Map<string, number> {
  const limites = new Map<string, number>();
  for (const entrada of (raw ?? "").split(",")) {
    const [proceso, valorRaw, ...resto] = entrada.split(":").map((parte) => parte.trim());
    if (!proceso || !valorRaw || resto.length) continue;
    const valor = Number(valorRaw);
    if (Number.isFinite(valor) && valor > 0) limites.set(proceso, valor);
  }
  return limites;
}

export function cargarConfiguracionPoliticaApi(env: NodeJS.ProcessEnv = process.env): ConfiguracionPoliticaApi {
  const modoConfigurado = env.WOBI_AI_API_MODE;
  const modoRaw = (modoConfigurado ?? "observe").trim().toLowerCase();
  const modo: ModoPoliticaApi =
    modoRaw === "disabled" || modoRaw === "allowlist" || modoRaw === "observe"
      ? modoRaw
      : "disabled"; // una errata explícita nunca debe abrir el gasto

  return {
    modo,
    killSwitch: (env.WOBI_AI_API_KILL_SWITCH ?? "false").trim().toLowerCase() === "true",
    procesosPermitidos: new Set(
      (env.WOBI_AI_API_ALLOWED_PROCESSES ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    ),
    umbralAlertaDiariaUSD: numeroNoNegativo(env.WOBI_AI_API_DAILY_WARNING_USD),
    limiteDiarioUSD: numeroNoNegativo(env.WOBI_AI_API_DAILY_LIMIT_USD),
    limiteMensualUSD: numeroNoNegativo(env.WOBI_AI_API_MONTHLY_LIMIT_USD),
    limitesDiariosPorProceso: limitesDiariosPorProceso(
      env.WOBI_AI_API_PROCESS_DAILY_LIMITS
    ),
  };
}

export function evaluarPoliticaApi(
  config: ConfiguracionPoliticaApi,
  proceso: string,
  consumo: EstadoConsumoApi
): DecisionPoliticaApi {
  if (config.killSwitch) {
    return { permitida: false, motivo: "kill_switch_activo", soloObservacion: false };
  }

  if (config.modo === "disabled") {
    return { permitida: false, motivo: "api_deshabilitada", soloObservacion: false };
  }

  // "observe" conserva la observación de la allowlist, pero un techo
  // monetario configurado siempre es un techo real. El incidente del
  // 2026-09-20 demostró que ignorarlo permitió 405 llamadas automáticas y
  // $22,75 aunque el límite diario estaba fijado en $10.
  if (config.limiteDiarioUSD > 0 && consumo.gastoDiarioUSD >= config.limiteDiarioUSD) {
    return { permitida: false, motivo: "limite_diario_alcanzado", soloObservacion: false };
  }
  if (config.limiteMensualUSD > 0 && consumo.gastoMensualUSD >= config.limiteMensualUSD) {
    return { permitida: false, motivo: "limite_mensual_alcanzado", soloObservacion: false };
  }
  const limiteProceso = config.limitesDiariosPorProceso.get(proceso);
  if (limiteProceso && (consumo.gastoDiarioProcesoUSD ?? 0) >= limiteProceso) {
    return { permitida: false, motivo: "limite_diario_proceso_alcanzado", soloObservacion: false };
  }

  // Fase transitoria: la allowlist todavía solo se observa. Los límites de
  // arriba sí se aplican para que observar nunca signifique gasto ilimitado.
  if (config.modo === "observe") {
    return { permitida: true, motivo: "modo_observacion", soloObservacion: true };
  }

  if (!config.procesosPermitidos.has(proceso)) {
    return { permitida: false, motivo: "proceso_no_autorizado", soloObservacion: false };
  }
  if (config.limiteDiarioUSD <= 0 || config.limiteMensualUSD <= 0) {
    return { permitida: false, motivo: "limites_no_configurados", soloObservacion: false };
  }
  return { permitida: true, motivo: "proceso_y_presupuesto_autorizados", soloObservacion: false };
}

export class UsoApiNoAutorizadoError extends Error {
  constructor(public readonly proceso: string, public readonly motivo: string) {
    super(`Uso de API de IA bloqueado para "${proceso}": ${motivo}.`);
    this.name = "UsoApiNoAutorizadoError";
  }
}

export function crearEjecucionIA(proceso: string): EjecucionIA {
  let llamada = 0;
  return {
    id: randomUUID(),
    proceso,
    siguienteLlamada: () => ++llamada,
  };
}

/**
 * Guardia previa a cualquier gasto. No recibe prompts, resultados ni
 * secretos. Consulta únicamente los totales monetarios ya registrados
 * cuando existe al menos un techo efectivo, también en modo observe.
 */
export async function autorizarLlamadaApi(proceso: string, referenceDate: Date = new Date()): Promise<DecisionPoliticaApi> {
  const config = cargarConfiguracionPoliticaApi();
  if (config.killSwitch || config.modo === "disabled") {
    const decision = evaluarPoliticaApi(config, proceso, { gastoDiarioUSD: 0, gastoMensualUSD: 0 });
    throw new UsoApiNoAutorizadoError(proceso, decision.motivo);
  }
  const limiteProceso = config.limitesDiariosPorProceso.get(proceso) ?? 0;
  const hayLimiteEfectivo = config.limiteDiarioUSD > 0 || config.limiteMensualUSD > 0 || limiteProceso > 0;
  if (config.modo === "observe" && !hayLimiteEfectivo) {
    return evaluarPoliticaApi(config, proceso, { gastoDiarioUSD: 0, gastoMensualUSD: 0 });
  }

  const consumo = await obtenerConsumoActualApi(proceso, referenceDate);
  const decision = evaluarPoliticaApi(config, proceso, {
    gastoDiarioUSD: consumo.gastoDiarioUSD,
    gastoMensualUSD: consumo.gastoMensualUSD,
    gastoDiarioProcesoUSD: consumo.gastoDiarioProcesoUSD,
  });
  if (!decision.permitida) throw new UsoApiNoAutorizadoError(proceso, decision.motivo);
  return decision;
}
