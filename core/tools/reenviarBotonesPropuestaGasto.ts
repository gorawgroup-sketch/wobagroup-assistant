import { obtenerPropuestasGastoPorChat } from "../gastos/gastoProposalSheet";
import { reenviarPropuestaGasto } from "../gastos/reenviarPropuestaGasto";
import type { ToolDefinition } from "./types";

/**
 * Caso real (2026-09-07): una propuesta de gasto de Uber tenía ya un movimiento bancario
 * coincidente ("Crear y conciliar" disponible), Carlos marcó "💰 Ajustar monto" con el teclado de
 * checkboxes, corrigió el monto por texto libre, y luego — en vez de tocar el botón que reapareció
 * en el mensaje ORIGINAL de la propuesta (arriba en el chat, ya scrolleado tras varios mensajes
 * intermedios) — escribió "sí, créalo y concilia" directo en el chat. El asistente conversacional no
 * tenía ninguna herramienta para reconocer eso: usó por error reintentar_gasto_pendiente (pensada
 * solo para la pregunta de "falta la empresa/moneda" DE ANTES de mandar la propuesta, no para una ya
 * completa esperando la decisión final), esa tool no encontró nada, y terminó diciéndole a Carlos
 * "no tengo herramienta para crear el gasto desde cero, reenvía el recibo" — FALSO (la propuesta
 * seguía viva y completa en Sheets) y además peligroso: reenviar el documento habría arriesgado un
 * gasto duplicado.
 *
 * Diseño: esta tool NUNCA ejecuta la creación/conciliación/cancelación ella misma. Es un invariante
 * ya auditado de este sistema (ver conciliarMovimiento.ts): crear/adjuntar/conciliar un gasto SIEMPRE
 * pasa por un botón real que muestra el match exacto antes de escribir en Holded — nunca se dispara
 * solo porque el modelo interpretó una instrucción en texto libre. Además, gasto_nuevo/
 * gasto_nuevo_conciliar/gasto_cancelar están protegidos en ACCIONES_SENSIBLES (solo superadmin) — esa
 * verificación vive en el router de callback_query real (src/server.ts), así que una tool que llamara
 * directo al handler la saltaría por completo. En vez de eso, esta tool reenvía un mensaje NUEVO
 * (visible, al final del chat) con los MISMOS botones reales de la propuesta — cierra el hueco real
 * (los botones existían pero quedaron fuera de vista) sin romper ninguna de las dos protecciones.
 */
export const reenviarBotonesPropuestaGastoTool: ToolDefinition = {
  name: "reenviar_botones_propuesta_gasto",
  description:
    "Vuelve a mostrar, en un mensaje NUEVO al final del chat, los botones reales (✅ Crear / ✅ Crear y " +
    "conciliar / ❌ Cancelar / etc.) de una propuesta de gasto que sigue pendiente — úsala cuando el usuario " +
    "responda en TEXTO LIBRE para aprobar/crear/cancelar esa propuesta (ej. 'créalo', 'sí, créalo y concilia', " +
    "'cancela ese gasto') en vez de tocar los botones del mensaje original. NUNCA crea/cancela/concilia nada " +
    "por sí sola — esas escrituras en Holded siempre requieren que el usuario toque el botón real (mismo " +
    "criterio que el resto del sistema), así que después de llamar a esta tool dile al usuario que toque el " +
    "botón que corresponde a lo que pidió, ya renovado al final del chat. Nunca digas que no hay forma de " +
    "crear el gasto ni pidas que reenvíen el documento — la propuesta ya existe completa.",
  input_schema: { type: "object", properties: {} },
  handler: async (_input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede reenviar ninguna propuesta de gasto.";
    }

    const pendientes = await obtenerPropuestasGastoPorChat(chatId);
    if (pendientes.length === 0) {
      return (
        "No hay ninguna propuesta de gasto pendiente en este chat — puede que ya se haya resuelto o cancelado. " +
        "No le pidas al usuario que reenvíe el documento sin más: dile que revise si ya se resolvió, o pídele " +
        "el proveedor/monto para investigar antes de asumir que hay que reenviar nada."
      );
    }

    if (pendientes.length > 1) {
      const lista = pendientes
        .map((p, i) => `${i + 1}. ${p.proveedor} — ${p.monto.toFixed(2)} ${p.moneda} (${p.fecha})`)
        .join("\n");
      return (
        `Hay ${pendientes.length} propuestas de gasto pendientes en este chat — pregúntale al usuario cuál es ` +
        `(por proveedor y monto, nunca adivines por orden) antes de reenviar ninguna:\n${lista}`
      );
    }

    const propuesta = pendientes[0];
    await reenviarPropuestaGasto(propuesta, "🔁 Botones renovados — toca la decisión que quieras aplicar.");

    return (
      `Listo — reenvié los botones reales de la propuesta de "${propuesta.proveedor}" (${propuesta.monto.toFixed(2)} ${propuesta.moneda}) ` +
      `al final del chat. Dile al usuario que toque el botón que corresponde a lo que pidió — esta tool no creó, ` +
      `canceló ni concilió nada, eso solo pasa cuando él toque el botón real.`
    );
  },
};
