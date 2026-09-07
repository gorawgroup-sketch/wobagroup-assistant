import Anthropic from "@anthropic-ai/sdk";
import { registrarUsoIA } from "../claude/costTracking";
import { autorizarLlamadaApi, type EjecucionIA } from "./policy";

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
  await autorizarLlamadaApi(ejecucion.proceso);
  const llamadaNumero = ejecucion.siguienteLlamada();
  const response = await anthropic.messages.create(params);

  registrarUsoIA(chatId, String(params.model), response.usage, {
    proceso: ejecucion.proceso,
    autenticacion: "anthropic_api_key",
    ejecucionId: ejecucion.id,
    llamadaNumero,
  }).catch((error) => console.error("[costTracking] Error registrando métricas de IA:", error));

  return response;
}
