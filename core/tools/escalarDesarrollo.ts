import { crearEscalacionDesarrollo, actualizarMessageIdEscalacion } from "../github/escalacionDesarrolloStore";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos (2026-09-09): "asegúrate que desde el chat podemos escalar directamente
 * a esta instancia... para que desde el chat podamos programar lo necesario sin tener que copiar y
 * pegar". Antes de esto, un bug/mejora detectado en el chat solo llegaba a development si Carlos
 * capturaba manualmente una captura de pantalla o copiaba el texto en una sesión de Claude Code aparte.
 *
 * Hallazgo real de auditoría xhigh (3 ángulos independientes coincidieron): la primera versión de esta
 * tool creaba el GitHub Issue DIRECTO al llamarse, sin ningún paso de confirmación — a diferencia de
 * TODA otra tool de este registro con un efecto externo real (proponer_envio_correo, proponer_evento_
 * calendario, proponer_edicion_compra_holded...), que sigue el patrón "proponer + botones de Telegram,
 * nunca ejecutar directo". Un Issue de GitHub es de la misma naturaleza que un correo enviado (visible
 * para terceros, con notificaciones) — se corrigió para seguir el mismo patrón ya establecido: esta
 * tool solo guarda el borrador y lo muestra con botones, la creación real ocurre en
 * escalacionCallbackHandler.ts, gateada a superadmin igual que el resto de escrituras del sistema (ver
 * ACCIONES_SENSIBLES en core/telegram/authorizedUsersSheet.ts).
 */
export const escalarDesarrolloTool: ToolDefinition = {
  name: "escalar_a_development",
  description:
    "Prepara un reporte para escalar un bug o una mejora del chat a development y lo muestra por " +
    "Telegram con botones para aprobarlo o cancelarlo — úsala SOLO cuando el usuario pida explícitamente " +
    "escalar/reportar/mandar algo a development (o confirme que sí quiere hacerlo tras preguntárselo), " +
    "nunca por iniciativa propia solo porque detectaste un error. El GitHub Issue real NUNCA se crea al " +
    "llamar esta herramienta, solo cuando se aprueba el botón — igual que proponer_envio_correo.",
  input_schema: {
    type: "object",
    properties: {
      titulo: {
        type: "string",
        description: "Título corto y específico del issue (ej. 'Recibos simplificados no deben discriminar IVA').",
      },
      cuerpo: {
        type: "string",
        description:
          "Reporte COMPLETO y autocontenido en markdown — quien lo lea en development no tiene el historial " +
          "de este chat, así que debe bastarse solo. Incluye: qué está pasando mal (comportamiento actual) y " +
          "qué debería pasar (comportamiento esperado); el/los caso(s) real(es) concreto(s) que lo motivaron " +
          "tal como se mencionaron en el chat (proveedor, monto, fecha, persona, empresa — los datos reales, " +
          "nunca inventados ni genéricos); y cualquier archivo/función ya mencionada en la conversación si " +
          "aplica. Nunca resumas de más — mejor un reporte largo y completo que uno corto y ambiguo.",
      },
      urgente: {
        type: "boolean",
        description: "true si el usuario dejó claro que esto es urgente/bloqueante (ej. un error que se sigue repitiendo en producción ahora mismo).",
      },
    },
    required: ["titulo", "cuerpo"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) {
      return "Error: no se pudo determinar el chat de Telegram donde mostrar la propuesta.";
    }

    const titulo = typeof input.titulo === "string" ? input.titulo.trim() : "";
    const cuerpo = typeof input.cuerpo === "string" ? input.cuerpo.trim() : "";
    if (!titulo) return "Error: falta 'titulo'.";
    if (!cuerpo) return "Error: falta 'cuerpo'.";

    const urgente = input.urgente === true || input.urgente === "true";

    const escalacion = await crearEscalacionDesarrollo({ chatId, messageId: 0, titulo, cuerpo, urgente });

    const texto = [
      `${urgente ? "🔴 URGENTE — " : ""}📋 Propuesta de escalación a development:`,
      ``,
      `**${titulo}**`,
      ``,
      cuerpo,
    ].join("\n");

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "📤 Crear issue", callback_data: `escaladev_confirmar:${escalacion.id}` },
        { text: "❌ Cancelar", callback_data: `escaladev_cancelar:${escalacion.id}` },
      ],
    ]);

    await actualizarMessageIdEscalacion(escalacion.id, messageId);

    return "Propuesta de escalación mostrada al usuario por Telegram con botones para aprobar (crea el issue real) o cancelar.";
  },
};
