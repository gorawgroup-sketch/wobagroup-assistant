import { randomUUID } from "node:crypto";
import { obtenerResumenCostos } from "../claude/costTracking";

export type ModoPoliticaApi = "observe" | "disabled" | "allowlist";

export interface ConfiguracionPoliticaApi {
  modo: ModoPoliticaApi;
  killSwitch: boolean;
  procesosPermitidos: Set<string>;
  limiteDiarioUSD: number;
  limiteMensualUSD: number;
}

export interface EstadoConsumoApi {
  gastoDiarioUSD: number;
  gastoMensualUSD: number;
}

export interface DecisionPoliticaApi {
  permitida: boolean;
  motivo: string;
  soloObservacion: boolean;
}

export interface EjecucionIA {
  id: string;
  proceso: string;
  siguienteLlamada(): number;
}

function numeroNoNegativo(raw: string | undefined): number {
  if (!raw?.trim()) return 0;
  const valor = Number(raw);
  return Number.isFinite(valor) && valor >= 0 ? valor : 0;
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
    limiteDiarioUSD: numeroNoNegativo(env.WOBI_AI_API_DAILY_LIMIT_USD),
    limiteMensualUSD: numeroNoNegativo(env.WOBI_AI_API_MONTHLY_LIMIT_USD),
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

  // Fase transitoria segura: observa sin cambiar el comportamiento actual.
  // El informe de migración define cuándo pasar cada proceso a allowlist o
  // disabled después de validar su alternativa durante varios ciclos.
  if (config.modo === "observe") {
    return { permitida: true, motivo: "modo_observacion", soloObservacion: true };
  }

  if (config.modo === "disabled") {
    return { permitida: false, motivo: "api_deshabilitada", soloObservacion: false };
  }

  if (!config.procesosPermitidos.has(proceso)) {
    return { permitida: false, motivo: "proceso_no_autorizado", soloObservacion: false };
  }
  if (config.limiteDiarioUSD <= 0 || config.limiteMensualUSD <= 0) {
    return { permitida: false, motivo: "limites_no_configurados", soloObservacion: false };
  }
  if (consumo.gastoDiarioUSD >= config.limiteDiarioUSD) {
    return { permitida: false, motivo: "limite_diario_alcanzado", soloObservacion: false };
  }
  if (consumo.gastoMensualUSD >= config.limiteMensualUSD) {
    return { permitida: false, motivo: "limite_mensual_alcanzado", soloObservacion: false };
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
 * secretos. En allowlist consulta únicamente los totales monetarios ya
 * registrados; en observe no añade latencia ni lecturas externas.
 */
export async function autorizarLlamadaApi(proceso: string, referenceDate: Date = new Date()): Promise<DecisionPoliticaApi> {
  const config = cargarConfiguracionPoliticaApi();
  if (config.killSwitch || config.modo === "disabled") {
    const decision = evaluarPoliticaApi(config, proceso, { gastoDiarioUSD: 0, gastoMensualUSD: 0 });
    throw new UsoApiNoAutorizadoError(proceso, decision.motivo);
  }
  if (config.modo === "observe") {
    return evaluarPoliticaApi(config, proceso, { gastoDiarioUSD: 0, gastoMensualUSD: 0 });
  }

  const inicioDia = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const inicioMes = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
  const fin = new Date(referenceDate.getTime() + 1);
  const [dia, mes] = await Promise.all([
    obtenerResumenCostos(inicioDia, fin),
    obtenerResumenCostos(inicioMes, fin),
  ]);
  const decision = evaluarPoliticaApi(config, proceso, {
    gastoDiarioUSD: dia.gastoRealApiUSD,
    gastoMensualUSD: mes.gastoRealApiUSD,
  });
  if (!decision.permitida) throw new UsoApiNoAutorizadoError(proceso, decision.motivo);
  return decision;
}
