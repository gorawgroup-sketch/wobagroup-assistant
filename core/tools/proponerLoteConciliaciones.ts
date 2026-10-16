import type { Empresa } from "../holded/client";
import { estadoLote } from "../holded/loteConciliaciones/model";
import { proponerLoteConciliaciones } from "../holded/loteConciliaciones/proponer";
import { loteConciliaciones } from "../holded/loteConciliaciones/runtime";
import type { ToolDefinition } from "./types";

export const proponerLoteConciliacionesTool: ToolDefinition = {
  name: "proponer_lote_conciliaciones",
  description:
    "Prepara VARIAS conciliaciones «un gasto ↔ un cargo» ya identificadas y las muestra juntas con UN solo botón de aprobación (superadministrador). " +
    "Úsala cuando haya varias parejas gasto↔cargo demostradas (por ejemplo tras una auditoría de conciliación) en vez de proponerlas una a una. " +
    "Cada par necesita compra_id (ID real del gasto en Holded), cuenta_id y movimiento_id del cargo y la fecha bancaria; nunca inventes IDs ni uses el número de factura. " +
    "Todos los pares son de la misma empresa. Relee Holded, deja fuera con su motivo los pares que el lote no cubre (gasto o cargo en otra moneda, cargo mayor que el gasto, " +
    "gasto con pagos, cargo ya conciliado) y propone el resto; al aprobar, revalida TODOS antes de escribir el primero, los ejecuta de uno en uno verificando cada pago y se " +
    "detiene en el primero que no pueda verificar. En `motivo` explica la evidencia de cada emparejamiento. No escribe en Holded al proponer; no afirmes conciliado hasta que el lote esté «completado».",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"] },
      pares: {
        type: "array", minItems: 1, maxItems: 20,
        items: {
          type: "object",
          properties: {
            compra_id: { type: "string", description: "ID real del gasto en Holded." },
            cuenta_id: { type: "string", description: "ID de la cuenta bancaria del cargo." },
            movimiento_id: { type: "string", description: "ID del movimiento bancario." },
            fecha_movimiento: { type: "string", description: "Fecha bancaria del cargo YYYY-MM-DD." },
          },
          required: ["compra_id", "cuenta_id", "movimiento_id", "fecha_movimiento"], additionalProperties: false,
        },
      },
      motivo: { type: "string", maxLength: 500, description: "Evidencia de que cada cargo paga su gasto: importe exacto, proveedor, patrón mensual, factura leída…" },
    },
    required: ["empresa", "pares", "motivo"], additionalProperties: false,
  },
  handler: async (input, context) => {
    if (context?.chatId === undefined) return "No se puede preparar el lote sin un chat de aprobación.";
    const pares = Array.isArray(input.pares) ? input.pares.map((p) => {
      const x = (p ?? {}) as Record<string, unknown>;
      return { compraId: String(x.compra_id ?? ""), accountId: String(x.cuenta_id ?? ""), movementId: String(x.movimiento_id ?? ""), fecha: String(x.fecha_movimiento ?? "") };
    }) : [];
    try {
      const lote = await loteConciliaciones.preparar({ empresa: input.empresa as Empresa, chatId: context.chatId, pares, motivo: typeof input.motivo === "string" ? input.motivo : "" });
      await proponerLoteConciliaciones(lote.chatId, lote);
      return `Lote ${lote.id}: ${lote.incluidos.length} par(es) propuestos con su botón` + (lote.excluidos.length ? ` y ${lote.excluidos.length} fuera (con su motivo en el mensaje)` : "") +
        ". No se ha conciliado nada todavía; no digas que está hecho hasta que el lote esté completado.";
    } catch (error) {
      return `No se preparó el lote: ${error instanceof Error ? error.message : String(error)}. No se envió ninguna conciliación a Holded.`;
    }
  },
};

export const consultarLoteConciliacionesTool: ToolDefinition = {
  name: "consultar_lote_conciliaciones",
  description: "Consulta el registro persistente de un lote de conciliaciones y el avance verificado de cada par. Solo lectura del registro: no reintenta ni reanuda nada. " +
    "Un lote «incierto» o «parcial» requiere revisión; nunca lo des por resuelto.",
  input_schema: { type: "object", properties: { lote_id: { type: "string" } }, required: ["lote_id"] },
  handler: async (input, context) => {
    if (context?.chatId === undefined || typeof input.lote_id !== "string") return "Falta el chat o el ID del lote.";
    try { return estadoLote(await loteConciliaciones.consultar(input.lote_id, context.chatId)); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  },
};
