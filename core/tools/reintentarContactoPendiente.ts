import { consumirResolucionContactoPorChat, restaurarResolucionContacto } from "../gastos/contactoResolucionStore";
import { buscarContactoHolded, crearContactoHolded } from "../holded/write";
import { procesarGastoConContactoResuelto } from "../gastos/gastoCallbackHandler";
import { sendTelegramMessage } from "../telegram/client";
import type { ToolDefinition } from "./types";
import { conMutex } from "../utils/asyncMutex";

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
    "ya lo agregué') o cuando indique expresamente otro nombre de contacto existente que se debe usar. " +
    "Si ahora SÍ se encuentra, crea " +
    "el gasto completo (con el desglose de IVA, cuenta y tags ya calculados desde el principio) y reporta " +
    "el resultado real — nunca pidas de nuevo los datos de la factura, ya se leyeron. Pasa en " +
    "contacto_nombre el nombre existente que pidió usar. Si ordena crear uno con un nombre distinto, pasa " +
    "crear_contacto_nuevo_como. Si omites ambos, se busca el nombre original.",
  input_schema: {
    type: "object",
    properties: {
      contacto_nombre: {
        type: "string",
        description: "Nombre exacto del contacto de Holded que el usuario indicó expresamente; omitir para reintentar el proveedor original.",
      },
      crear_contacto_nuevo_como: {
        type: "string",
        description: "Nombre exacto con el que el usuario ordenó crear un contacto nuevo en Holded.",
      },
    },
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede reintentar ninguna resolución de contacto.";
    }

    const resolucion = await consumirResolucionContactoPorChat(chatId);
    if (!resolucion) {
      return "No hay ninguna pregunta de proveedor sin encontrar pendiente para este chat (puede que ya se haya procesado, o que haya expirado).";
    }

    const nombreSolicitado =
      typeof input.contacto_nombre === "string" && input.contacto_nombre.trim()
        ? input.contacto_nombre.trim()
        : resolucion.propuesta.proveedor;
    const nombreNuevo =
      typeof input.crear_contacto_nuevo_como === "string" && input.crear_contacto_nuevo_como.trim()
        ? input.crear_contacto_nuevo_como.trim()
        : undefined;

    let contacto;
    try {
      if (nombreNuevo) {
        const clave = `crearContacto:${resolucion.empresaFinal}:${nombreNuevo.toLowerCase()}`;
        contacto = await conMutex(clave, async () => {
          const existente = await buscarContactoHolded(resolucion.empresaFinal, nombreNuevo, resolucion.propuesta.moneda);
          return existente ?? crearContactoHolded(resolucion.empresaFinal, nombreNuevo);
        });
      } else {
        contacto = await buscarContactoHolded(resolucion.empresaFinal, nombreSolicitado, resolucion.propuesta.moneda);
      }
    } catch (error) {
      // Se reinserta el pendiente para no perderlo por un error transitorio (ej. Holded caído un momento).
      await restaurarResolucionContacto(resolucion).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      return `Error consultando Holded: ${message}. La pregunta sigue pendiente, se puede reintentar.`;
    }

    if (!contacto) {
      // Sigue sin existir — se reinserta el pendiente para poder reintentar de nuevo más tarde.
      await restaurarResolucionContacto(resolucion).catch((error) =>
        console.error("[reintentarContactoPendiente] Error reinsertando el pendiente:", error)
      );
      return (
        `Todavía no encuentro el contacto "${nombreSolicitado}" en Holded ` +
        `(${resolucion.empresaFinal}). Dile al usuario que confirme que lo creó con el nombre correcto, o que ` +
        `puede intentarlo de nuevo cuando lo haga.`
      );
    }

    await sendTelegramMessage(chatId, `🔄 Encontré "${contacto.name}" — procesando "${resolucion.propuesta.proveedor}"...`).catch(
      (error) => console.error("[reintentarContactoPendiente] No se pudo mostrar el progreso (no crítico):", error)
    );
    try {
      await procesarGastoConContactoResuelto(resolucion, { id: contacto.id, name: contacto.name ?? resolucion.propuesta.proveedor });
    } catch (error) {
      await restaurarResolucionContacto(resolucion).catch((errorRestaurando) =>
        console.error("[reintentarContactoPendiente] Error restaurando la resolución:", errorRestaurando)
      );
      const message = error instanceof Error ? error.message : String(error);
      return `No pude completar el gasto (${message}). La selección de proveedor sigue pendiente y se puede reintentar.`;
    }

    return (
      `Contacto encontrado ("${contacto.name}") y gasto procesado — el resultado real ya se le mostró al ` +
      `usuario por Telegram directamente, no hace falta que lo repitas.`
    );
  },
};
