import { buscarGastosDeEtiqueta } from "../holded/gastosPorEtiqueta";
import { describirCobertura } from "../informes/reintegroTelegram";
import { formatDateLocal } from "../utils/dateFormat";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

const DIAS_POR_DEFECTO = 730; // ~2 años — un hashtag de persona/proyecto suele acumularse a lo largo de mucho tiempo, no solo días recientes

export const buscarGastosPorEtiquetaTool: ToolDefinition = {
  name: "buscar_gastos_por_etiqueta_holded",
  seguraParaModoRapido: true,
  description:
    "Busca gastos de Holded (WOBA, EWORKS o Footprint) por ETIQUETA/hashtag de una persona, proyecto o categoría " +
    "(ej. 'jorge', 'nuria', 'transporte'). Incluye los TICKETS además de las facturas, y reconoce las variantes de la " +
    "etiqueta ('nuria' encuentra también 'nuriaortiz'). Devuelve cada gasto con su fecha, importe, estado de pago y " +
    "etiquetas, el total, y la cobertura real de la búsqueda — transmite esa cobertura al usuario y nunca afirmes que " +
    "'solo hay N' sin ella. Solo busca por etiqueta, no por proveedor ni descripción. Si piden un listado para " +
    "reclamar o refacturar los gastos, o un documento descargable, usa generar_informe_reintegro_gastos.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo a consultar." },
      etiqueta: { type: "string", description: "La etiqueta/hashtag a buscar (sin el símbolo #); basta el nombre de la persona." },
      dias: {
        type: "number",
        description: `Cuántos días hacia atrás buscar. Opcional, por defecto ${DIAS_POR_DEFECTO} (~2 años) — un hashtag suele acumularse durante mucho tiempo.`,
      },
    },
    required: ["empresa", "etiqueta"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const etiqueta = typeof input.etiqueta === "string" ? input.etiqueta.replace(/^#/, "").trim() : "";
    if (!etiqueta) return "Error: falta 'etiqueta'.";

    const dias = typeof input.dias === "number" && input.dias > 0 ? input.dias : DIAS_POR_DEFECTO;
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);

    // Incluye los tickets (que el listado de Holded no devuelve) y las variantes de la etiqueta: ver gastosPorEtiqueta.ts.
    const { gastos, cobertura } = await buscarGastosDeEtiqueta(empresa, etiqueta, formatDateLocal(desde), formatDateLocal(hasta));
    if (gastos.length === 0) {
      return `No encontré gastos de ${empresa} con la etiqueta "${etiqueta}" en los últimos ${dias} días. ${describirCobertura(cobertura)}`;
    }

    const estado = { pagado: "pagado", parcial: "pago parcial", sin_pagar: "sin pagar en banco" } as const;
    const lineas = gastos.map(
      (g) => `- [${g.id}] ${g.fecha} — ${`${g.proveedor}${g.descripcion ? ` — ${g.descripcion.slice(0, 90)}` : ""}`} — ${g.total.toFixed(2)} ${g.moneda} — ${estado[g.estado]} — etiquetas: ${g.tags.join(", ")}`
    );
    const total = gastos.reduce((suma, g) => suma + g.total, 0);

    return (
      `${gastos.length} gasto(s) de ${empresa} con la etiqueta "${etiqueta}" (y sus variantes) en los últimos ${dias} días; suman ${total.toFixed(2)}. ` +
      `El id entre corchetes sirve para leer sus adjuntos con leer_adjuntos_compra_holded. Para un informe PDF con totales de pagado/sin pagar ` +
      `y los comprobantes, usa generar_informe_reintegro_gastos.\n\n` +
      lineas.join("\n") +
      `\n\n${describirCobertura(cobertura)}`
    );
  },
};
