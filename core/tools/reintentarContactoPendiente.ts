import { consumirResolucionContactoPorChat, guardarResolucionContacto } from "../gastos/contactoResolucionStore";
import { buscarContactoHolded } from "../holded/write";
import { procesarGastoConContactoResuelto } from "../gastos/gastoCallbackHandler";
import { sendTelegramMessage } from "../telegram/client";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos, tras un caso real: se le avisó que un
 * proveedor ("iryo") no se encontró en los contactos de Holded, pidiéndole
 * que lo creara y avisara — pero si respondía en el mismo chat en vez de
 * reenviar la factura, el asistente no tenía ningún contexto de esa
 * pregunta pendiente. Esta tool le da al chat normal la capacidad de
 * reconocer esa situación, reintentar la búsqueda del contacto (que ahora
 * puede existir), e integrar la respuesta continuando el proceso de crear
 * el gasto — sin que el usuario tenga que reenviar el documento.
 * buildSystemPromptDinamico (core/claude/client.ts) avisa cuando hay una
 * de estas preguntas sin responder.
 */
export const reintentarContactoPendienteTool: ToolDefinition = {
  name: "reintentar_contacto_pendiente",
  description:
    "Reintenta encontrar el proveedor de un gasto que antes no se encontró en Holded — úsala cuando el " +
    "usuario confirme en texto libre que ya creó el contacto (ej. 'ya lo creé', 'listo', 'ya está', 'dale, " +
    "ya lo agregué') en respuesta a un aviso de 'no encontré el proveedor'. Si ahora SÍ se encuentra, crea " +
    "el gasto completo (con el desglose de IVA, cuenta y tags ya calculados desde el principio) y reporta " +
    "el resultado real — nunca pidas de nuevo los datos de la factura, ya se leyeron. Si el usuario en " +
    "cambio te da un nombre o id de contacto distinto para usar, no uses esta tool — dile que cree el " +
    "proveedor exacto en Holded, esta tool solo reintenta la búsqueda por el nombre real de la factura.",
  input_schema: { type: "object", properties: {} },
  handler: async (_input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede reintentar ninguna resolución de contacto.";
    }

    const resolucion = await consumirResolucionContactoPorChat(chatId);
    if (!resolucion) {
      return "No hay ninguna pregunta de proveedor sin encontrar pendiente para este chat (puede que ya se haya procesado, o que haya expirado).";
    }

    let contacto;
    try {
      contacto = await buscarContactoHolded(resolucion.empresaFinal, resolucion.propuesta.proveedor);
    } catch (error) {
      // Se reinserta el pendiente para no perderlo por un error transitorio (ej. Holded caído un momento).
      await guardarResolucionContacto({ ...resolucion }).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      return `Error consultando Holded: ${message}. La pregunta sigue pendiente, se puede reintentar.`;
    }

    if (!contacto) {
      // Sigue sin existir — se reinserta el pendiente para poder reintentar de nuevo más tarde.
      await guardarResolucionContacto({ ...resolucion }).catch((error) =>
        console.error("[reintentarContactoPendiente] Error reinsertando el pendiente:", error)
      );
      return (
        `Todavía no encuentro el proveedor "${resolucion.propuesta.proveedor}" en los contactos de Holded ` +
        `(${resolucion.empresaFinal}). Dile al usuario que confirme que lo creó con el nombre correcto, o que ` +
        `puede intentarlo de nuevo cuando lo haga.`
      );
    }

    await sendTelegramMessage(chatId, `🔄 Encontré "${contacto.name}" — procesando "${resolucion.propuesta.proveedor}"...`);
    await procesarGastoConContactoResuelto(resolucion, { id: contacto.id, name: contacto.name ?? resolucion.propuesta.proveedor });

    return (
      `Contacto encontrado ("${contacto.name}") y gasto procesado — el resultado real ya se le mostró al ` +
      `usuario por Telegram directamente, no hace falta que lo repitas.`
    );
  },
};
