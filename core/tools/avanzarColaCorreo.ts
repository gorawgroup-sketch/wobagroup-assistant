import { posponerCorreoActivoYContinuar } from "../gmail/posponerCorreoActivo";
import { procesarSiguienteCorreoActivo } from "../jobs/revisarCorreoNuevo";
import { obtenerActivoActual, contarPendientesTotal } from "../gmail/colaRevisionStore";
import type { ToolDefinition } from "./types";

/**
 * Hallazgo real de auditoría (Carlos, panel web/cerebro, 2026-09-15): pidió "revisa el mail" (bien —
 * revisar_cola_correo sincroniza y lista lo que hay) y luego "procésalos uno a uno" — y no había
 * NINGUNA herramienta conversacional que de verdad avanzara la cola. En Telegram, ese paso solo
 * ocurre al presionar el botón "▶️ Sí, siguiente" (ver handleColaCorreoSiguienteCallback en
 * revisarCorreoNuevo.ts), un callback_query — no algo que Claude pudiera disparar por su cuenta desde
 * ningún canal, ni siquiera Telegram por texto. Esta herramienta expone ese mismo paso
 * (procesarSiguienteCorreoActivo) como una acción real que Claude puede tomar cuando el usuario lo
 * pide en lenguaje natural — "procesa el siguiente", "sigue con la cola", "procésalos uno a uno" —
 * sin importar el canal.
 *
 * Segura para llamarse en secuencia/loop: si ya hay un correo activo esperando una decisión real
 * (ej. una propuesta de gasto con candidatos duplicados), iniciarSiguienteActivo es un no-op (ver su
 * propio comentario) — nunca reprocesa ni salta por encima de una decisión pendiente. Por eso, ante
 * "procésalos uno a uno" para varios correos, Claude puede llamar esta herramienta varias veces
 * seguidas en el mismo turno: sigue avanzando sola mientras cada correo se resuelve sin necesitar una
 * decisión humana, y se detiene sola (sin volver a avanzar) en cuanto uno de verdad la necesita.
 */
export const avanzarColaCorreoTool: ToolDefinition = {
  name: "procesar_siguiente_correo_cola",
  description:
    "Procesa de verdad el siguiente correo sin leer de la cola (ya sincronizada con revisar_cola_correo) — " +
    "descarga y lee sus adjuntos o su cuerpo, decide si es un gasto/documento/solicitud, y manda la propuesta " +
    "o resolución correspondiente. Úsala cuando el usuario pida explícitamente avanzar/procesar la cola " +
    "('procésalos uno a uno', 'procesa el siguiente', 'sigue con el que sigue', 'continúa') — nunca antes de " +
    "que haya pedido avanzar (revisar_cola_correo por sí sola solo sincroniza y muestra qué hay, no procesa " +
    "nada). Si ya hay un correo activo esperando una decisión real (ej. confirmar un posible gasto duplicado), " +
    "usa aplazar_actual=true si el usuario quiere dejarlo pendiente y continuar con OTROS correos. Si pide resolver el gasto actual, resuelve esa decisión antes de " +
    "volver a llamarla. Puedes llamarla varias veces seguidas para procesar varios correos en el mismo turno; " +
    "se detiene sola en el primero que de verdad necesite que el usuario decida algo.",
  input_schema: { type: "object", properties: {
    aplazar_actual: { type: "boolean", description: "true cuando el usuario pide continuar con OTROS correos dejando el actual pendiente, incluso tras aceptar el análisis de movimiento ya conciliado. Conserva el actual sin leer; no crea ni concilia ni descarta gastos." },
  } },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar la conversación para procesar la cola de correo.";

    if (input.aplazar_actual === true) return posponerCorreoActivoYContinuar(chatId);
    const activoAntes = await obtenerActivoActual(chatId);
    if (activoAntes) {
      return (
        `Ya hay un correo activo esperando una decisión: "${activoAntes.asunto}" (de ${activoAntes.de}) — ` +
        "Si el usuario ya pidió dejarlo pendiente y continuar con otros, llama esta herramienta con aplazar_actual=true; no hace falta pedir otra confirmación."
      );
    }

    await procesarSiguienteCorreoActivo(chatId);

    const activoDespues = await obtenerActivoActual(chatId);
    const quedan = await contarPendientesTotal(chatId);

    if (activoDespues) {
      return (
        `Procesé "${activoDespues.asunto}" (de ${activoDespues.de}) — quedó activo esperando una decisión real ` +
        "(ver el mensaje/propuesta que se acaba de mandar arriba). Resuélvelo antes de llamar de nuevo a esta " +
        "herramienta."
      );
    }

    if (quedan === 0) {
      return "Procesé ese correo y ya no queda ninguno más sin leer en la cola.";
    }

    return `Procesé ese correo (se resolvió solo, sin necesitar una decisión). Quedan ${quedan} correo(s) más en la cola — llama de nuevo a esta herramienta para seguir con el siguiente.`;
  },
};
