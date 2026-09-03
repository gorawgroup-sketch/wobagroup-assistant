import { buscarDocumentosHolded } from "../holded/write";
import { crearPendienteEdicionCompraHolded, actualizarMessageIdEdicionCompraHolded } from "../holded/pendienteEdicionCompraHoldedStore";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos, tras un caso real (un gasto de McDonald's ya
 * creado en Holded con el monto y el número de documento mal — antes solo
 * se podía corregir a mano en la web de Holded, o borrar y recrear desde
 * cero, perdiendo el id real y cualquier conciliación ya hecha contra él):
 * "necesito que hagas lo que dices que no puedes hacer". Igual que CUALQUIER
 * otra escritura real de este sistema, esto NUNCA edita nada por sí solo —
 * solo busca la compra, arma la propuesta de edición, y la muestra con
 * botones de aprobación (ver edicionCompraHoldedCallbackHandler.ts). El
 * PUT real de Holded reemplaza el documento ENTERO (ver editarCompraHolded,
 * core/holded/write.ts) — por eso esta herramienta nunca intenta tocar
 * líneas/conceptos arbitrarios por texto libre, solo dos correcciones
 * puntuales y bien acotadas (número de documento, monto total).
 */
export const proponerEdicionCompraHoldedTool: ToolDefinition = {
  name: "proponer_edicion_compra_holded",
  description:
    "Propone corregir el número de documento y/o el monto total de una compra/gasto YA CREADO en Holded " +
    "(nunca lo edita directo — solo muestra la propuesta con botones Confirmar/Cancelar). Úsala cuando te " +
    "pidan corregir, arreglar o cambiar un dato de un gasto que ya está registrado en Holded (no uno nuevo " +
    "por registrar — para eso está el flujo normal de propuesta de gasto). Si hay varias compras parecidas " +
    "que podrían ser la correcta, en vez de proponer nada te devuelve la lista para que el usuario aclare " +
    "cuál es (con id, número de documento actual, fecha y monto de cada una) — nunca adivines cuál es si " +
    "hay más de una coincidencia real.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo cuyo Holded se edita." },
      contacto: {
        type: "string",
        description: "Nombre (o parte del nombre) del proveedor de la compra a corregir — ej. 'McDonald's', 'OUIGO'.",
      },
      monto_actual_aproximado: {
        type: "number",
        description: "Monto total actual de la compra (tal como está hoy en Holded), para acotar la búsqueda si hay varias compras del mismo proveedor. Opcional pero recomendado.",
      },
      numero_documento_nuevo: {
        type: "string",
        description: "El número de documento correcto a dejar (ej. el que trae impreso el ticket/factura real). Opcional si solo se corrige el monto.",
      },
      monto_nuevo: {
        type: "number",
        description: "El monto TOTAL correcto a dejar (ej. el total con IVA real de la factura). Opcional si solo se corrige el número de documento.",
      },
    },
    required: ["empresa", "contacto"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) {
      return "Error: no se pudo determinar el chat de Telegram donde mostrar la propuesta de edición.";
    }

    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const contacto = typeof input.contacto === "string" ? input.contacto.trim() : "";
    if (!contacto) {
      return "Error: hace falta 'contacto' (nombre o parte del nombre del proveedor de la compra a corregir).";
    }

    const numeroDocumentoNuevo =
      typeof input.numero_documento_nuevo === "string" && input.numero_documento_nuevo.trim() ? input.numero_documento_nuevo.trim() : undefined;
    const montoNuevo = typeof input.monto_nuevo === "number" ? input.monto_nuevo : undefined;
    if (numeroDocumentoNuevo === undefined && montoNuevo === undefined) {
      return "Error: hace falta al menos uno de 'numero_documento_nuevo' o 'monto_nuevo' — qué corregir.";
    }

    const montoActualAprox = typeof input.monto_actual_aproximado === "number" ? input.monto_actual_aproximado : undefined;

    const encontrados = await buscarDocumentosHolded(empresa, { contacto, monto: montoActualAprox, tipo: "gasto", dias: 365 });

    if (encontrados.length === 0) {
      return `No encontré ninguna compra de "${contacto}" en Holded (${empresa}) en el último año — verifica el nombre del proveedor, o si es de otra empresa.`;
    }

    if (encontrados.length > 1) {
      const listado = encontrados
        .map((d, i) => `${i + 1}. id ${d.id} — ${d.contactName}, ${d.total.toFixed(2)} €, doc "${d.documentNumber || "(sin número)"}", ${d.fecha}`)
        .join("\n");
      return (
        `Encontré ${encontrados.length} compras de "${contacto}" — dime cuál corresponde (o dame el monto exacto/fecha para acotar):\n${listado}`
      );
    }

    const compra = encontrados[0];
    const resumenAntes = `${compra.contactName} — ${compra.total.toFixed(2)} €, doc "${compra.documentNumber || "(sin número)"}", ${compra.fecha}`;
    const cambiosTexto = [
      numeroDocumentoNuevo !== undefined ? `número de documento → "${numeroDocumentoNuevo}"` : undefined,
      montoNuevo !== undefined ? `monto total → ${montoNuevo.toFixed(2)} €` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    // Bug real de auditoría: buscarDocumentosHolded, cuando no encuentra
    // ningún match por nombre de proveedor, cae a una segunda pasada que
    // busca SOLO por monto en TODOS los proveedores — un único resultado ahí
    // puede ser de un proveedor totalmente distinto al que se pidió corregir.
    // Nunca proponer eso en silencio como si fuera un match seguro.
    const notaSoloPorMonto = compra.coincidenciaSoloPorMonto
      ? `\n\n⚠️ No encontré ninguna compra de "${contacto}" por nombre — esta es la única que coincide por MONTO, de otro proveedor (${compra.contactName}). Verifica que sea la correcta antes de confirmar.`
      : "";

    const texto =
      `✏️ *Propuesta de edición en Holded* — ${resumenAntes}\n\n` +
      `Cambiar: ${cambiosTexto}.\n\n` +
      `Esto reemplaza el documento completo en Holded (id ${compra.id}) — el comprobante/adjunto y cualquier ` +
      `pago o conciliación ya hecha contra él NO se tocan.` +
      notaSoloPorMonto;

    const pendiente = await crearPendienteEdicionCompraHolded({
      chatId,
      messageId: 0,
      empresa,
      purchaseId: compra.id,
      cambios: { numeroDocumento: numeroDocumentoNuevo, montoNuevo },
      resumenAntes,
    });

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "✅ Confirmar edición", callback_data: `edicioncompra_confirmar:${pendiente.id}` },
        { text: "❌ Cancelar", callback_data: `edicioncompra_cancelar:${pendiente.id}` },
      ],
    ]);
    await actualizarMessageIdEdicionCompraHolded(pendiente.id, messageId);

    return `Propuesta de edición mostrada por Telegram con botones — no se editó nada todavía, falta la aprobación.`;
  },
};
