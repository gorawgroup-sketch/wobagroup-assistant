import { buscarGastosSinComprobante } from "../holded/write";
import { formatDateLocal } from "../utils/dateFormat";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

const DIAS_POR_DEFECTO = 90;

export const gastosSinComprobanteTool: ToolDefinition = {
  name: "consultar_gastos_sin_comprobante",
  description:
    "Consulta qué gastos de Holded (WOBA, EWORKS o Footprint) NO tienen ningún comprobante/factura " +
    "adjunto todavía, en un rango de días hacia atrás. Úsala cuando pregunten qué gastos faltan de " +
    "soporte, quién debe mandar un recibo, o algo similar. Si el gasto tiene una etiqueta con el " +
    "nombre de una persona (ej. gastos personales de un colaborador), inclúyela — es la única pista " +
    "de a quién corresponde; para el resto solo se sabe el proveedor, no quién debe conseguir el soporte.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo a consultar." },
      dias: {
        type: "number",
        description: `Cuántos días hacia atrás revisar. Opcional, por defecto ${DIAS_POR_DEFECTO}.`,
      },
    },
    required: ["empresa"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const dias = typeof input.dias === "number" && input.dias > 0 ? input.dias : DIAS_POR_DEFECTO;
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);

    const { sinComprobante, totalRevisados, limiteAlcanzado } = await buscarGastosSinComprobante(
      empresa,
      formatDateLocal(desde),
      formatDateLocal(hasta)
    );

    if (sinComprobante.length === 0) {
      return `Revisé ${totalRevisados} gasto(s) de ${empresa} de los últimos ${dias} días — todos tienen comprobante adjunto.`;
    }

    const lineas = sinComprobante.map((g) => {
      const responsable = g.tags.length > 0 ? ` — posible responsable/etiqueta: ${g.tags.join(", ")}` : "";
      return `- ${g.contactName} — ${g.total.toFixed(2)} € (${g.fecha}) — ${g.descripcion}${responsable}`;
    });

    const nota = limiteAlcanzado
      ? `\n\n(Se revisaron solo los primeros ${totalRevisados} gastos del periodo — hay más, prueba con menos días si quieres acotar.)`
      : "";

    return (
      `${sinComprobante.length} gasto(s) de ${empresa} sin comprobante adjunto (de ${totalRevisados} revisados, últimos ${dias} días):\n\n` +
      lineas.join("\n") +
      nota
    );
  },
};
