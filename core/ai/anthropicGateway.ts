import Anthropic from "@anthropic-ai/sdk";
import { registrarUsoIA } from "../claude/costTracking";
import { autorizarLlamadaApi, type EjecucionIA } from "./policy";
import { enteroAcotado, TiempoMaximoExcedidoError } from "../utils/asyncTimeout";
import { validarPresupuestoSolicitudIA } from "./requestBudget";

export function configuracionSolicitudAnthropic(model: string, env: NodeJS.ProcessEnv = process.env) {
  const raw = model.includes("haiku") ? env.WOBI_AI_HAIKU_TIMEOUT_MS
    : model.includes("sonnet") ? env.WOBI_AI_SONNET_TIMEOUT_MS : env.WOBI_AI_OTHER_TIMEOUT_MS;
  const defecto = model.includes("haiku") ? 60_000 : model.includes("sonnet") ? 120_000 : 180_000;
  return {
    timeout: enteroAcotado(raw, defecto, 5_000, 300_000),
    maxRetries: enteroAcotado(env.WOBI_AI_MAX_RETRIES, 0, 0, 2),
  };
}

/** El aborto abarca cabeceras, cuerpo y reintentos; el timeout del SDK solo no basta. */
export async function conLimiteSolicitud<T>(
  ejecutar: (signal: AbortSignal) => Promise<T>, timeout: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await ejecutar(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || error instanceof Anthropic.APIConnectionTimeoutError) {
      throw new TiempoMaximoExcedidoError("solicitud_modelo", timeout);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Único punto autorizado para una llamada facturable a Anthropic. La
 * política se evalúa antes del gasto y el registro posterior contiene solo
 * métricas, nunca prompts, resultados, credenciales ni datos de negocio.
 */
export async function crearMensajeAnthropic(
  anthropic: Anthropic,
  ejecucion: EjecucionIA,
  params: Anthropic.MessageCreateParamsNonStreaming,
  chatId?: number
): Promise<Anthropic.Message> {
  const llamadaNumero = ejecucion.siguienteLlamada();
  try {
    validarPresupuestoSolicitudIA(ejecucion.proceso, llamadaNumero, params);
  } catch (error) {
    console.warn("[ai/budget]", JSON.stringify({
      ejecucionId: ejecucion.id,
      proceso: ejecucion.proceso,
      llamadaNumero,
      error: error instanceof Error ? error.name : "Error",
    }));
    throw error;
  }
  await autorizarLlamadaApi(ejecucion.proceso);
  const config = configuracionSolicitudAnthropic(String(params.model));
  const inicio = Date.now();
  let response: Anthropic.Message;
  try {
    response = await conLimiteSolicitud(
      (signal) => anthropic.messages.create(params, { ...config, signal }), config.timeout
    );
  } catch (error) {
    console.warn("[ai/request]", JSON.stringify({
      ejecucionId: ejecucion.id, proceso: ejecucion.proceso, modelo: params.model,
      llamadaNumero, duracionMs: Date.now() - inicio,
      error: error instanceof Error ? error.name : "Error",
      // Una respuesta perdida puede ser facturable; nunca contabilizarla como coste cero.
      consumo: "no_confirmado",
    }));
    throw error;
  }

  registrarUsoIA(chatId, String(params.model), response.usage, {
    proceso: ejecucion.proceso,
    autenticacion: "anthropic_api_key",
    ejecucionId: ejecucion.id,
    llamadaNumero,
  }).catch((error) => console.error("[costTracking] Error registrando métricas de IA:", error));

  return response;
}
