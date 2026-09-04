import { leerAdjuntosCompraHolded } from "../holded/write";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

export const leerAdjuntosCompraHoldedTool: ToolDefinition = {
  name: "leer_adjuntos_compra_holded",
  seguraParaModoRapido: true,
  description:
    "Lee el contenido REAL (no solo el nombre) de los adjuntos/comprobantes de un gasto ya existente " +
    "en Holded, dado su id (el mismo id que devuelven buscar_gastos_por_etiqueta_holded o " +
    "consultar_movimientos_holded). Úsala cuando un gasto tenga una descripción genérica ('Expenses', " +
    "'Reintegro de gastos') y necesites saber qué cubre de verdad — descarga y transcribe cada adjunto " +
    "(PDF o imagen). Si el gasto no tiene ningún adjunto, o el adjunto no trae desglose (una autofactura " +
    "de un solo importe sin detalle, por ejemplo), dilo tal cual en vez de inventar un desglose que no " +
    "está — es información real, no debe completarse con suposiciones.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo a la que pertenece el gasto." },
      purchase_id: { type: "string", description: "El id del gasto/compra en Holded (no el número de documento, el id interno)." },
    },
    required: ["empresa", "purchase_id"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const purchaseId = typeof input.purchase_id === "string" ? input.purchase_id.trim() : "";
    if (!purchaseId) return "Error: falta 'purchase_id'.";

    const adjuntos = await leerAdjuntosCompraHolded(empresa, purchaseId);

    if (adjuntos.length === 0) {
      return `El gasto ${purchaseId} de ${empresa} no tiene ningún adjunto en Holded.`;
    }

    return adjuntos
      .map((a) => `📎 ${a.nombreArchivo}:\n${a.contenido}`)
      .join("\n\n---\n\n");
  },
};
