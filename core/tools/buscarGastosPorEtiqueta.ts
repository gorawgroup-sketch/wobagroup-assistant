import { buscarGastosPorEtiquetaHolded } from "../holded/write";
import { formatDateLocal } from "../utils/dateFormat";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

const DIAS_POR_DEFECTO = 730; // ~2 años — un hashtag de persona/proyecto suele acumularse a lo largo de mucho tiempo, no solo días recientes

export const buscarGastosPorEtiquetaTool: ToolDefinition = {
  name: "buscar_gastos_por_etiqueta_holded",
  seguraParaModoRapido: true,
  description:
    "Busca gastos de Holded (WOBA, EWORKS o Footprint) por ETIQUETA/hashtag exacta (ej. 'jorge', " +
    "'transporte', 'proyectosimon') — úsala cuando pregunten por los gastos de una persona, proyecto o " +
    "categoría concreta usando su hashtag. La etiqueta se compara sin distinguir mayúsculas ni acentos, " +
    "pero debe ser exacta (no una palabra parecida) — si no sabes el hashtag exacto, primero puedes " +
    "listar unos cuantos gastos con consultar_movimientos_holded para ver qué etiquetas existen. Solo " +
    "encuentra coincidencias por ETIQUETA, no por proveedor ni descripción — si buscas por el nombre de " +
    "un proveedor usa otra herramienta.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo a consultar." },
      etiqueta: { type: "string", description: "La etiqueta/hashtag exacta a buscar (sin el símbolo #)." },
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

    const etiqueta = typeof input.etiqueta === "string" ? input.etiqueta.trim() : "";
    if (!etiqueta) return "Error: falta 'etiqueta'.";

    const dias = typeof input.dias === "number" && input.dias > 0 ? input.dias : DIAS_POR_DEFECTO;
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);

    const { resultados, totalRevisados, limiteAlcanzado } = await buscarGastosPorEtiquetaHolded(
      empresa,
      etiqueta,
      formatDateLocal(desde),
      formatDateLocal(hasta)
    );

    if (resultados.length === 0) {
      return `Revisé ${totalRevisados} gasto(s) de ${empresa} de los últimos ${dias} días — ninguno tiene la etiqueta "${etiqueta}".`;
    }

    const lineas = resultados.map(
      (g) => `- [${g.id}] ${g.contactName} — ${g.total.toFixed(2)} € (${g.fecha}) — ${g.descripcion} — etiquetas: ${g.tags.join(", ")}`
    );

    const nota = limiteAlcanzado
      ? `\n\n(Se revisaron solo los primeros ${totalRevisados} gastos del periodo — hay más, prueba con menos días si quieres acotar.)`
      : "";

    return (
      `${resultados.length} gasto(s) de ${empresa} con la etiqueta "${etiqueta}" (de ${totalRevisados} revisados, últimos ${dias} días). ` +
      `El id entre corchetes sirve para leer sus adjuntos con leer_adjuntos_compra_holded si hace falta más detalle:\n\n` +
      lineas.join("\n") +
      nota
    );
  },
};
