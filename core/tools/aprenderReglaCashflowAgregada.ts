import { listarReglasAgregadas, normalizarTextoRegla, quitarReglaAgregada, registrarReglaAgregada } from "../cashflow/reglasAgregadas";
import type { ToolDefinition } from "./types";

/**
 * Dictar por chat una regla «ya está sumado en otra línea» sin esperar al próximo aviso (mismo patrón que `fijar_alias_proveedor`:
 * aprendizaje interno, no escribe en Holded, banco ni cashflow). Pedido de Carlos, 2026-10-05, caso nóminas WOBA.
 */
export const aprenderReglaCashflowAgregadaTool: ToolDefinition = {
  name: "aprender_regla_cashflow_agregada",
  description:
    "Enseña (o consulta/quita) una regla del cashflow: los movimientos del banco de una empresa cuyo concepto contiene unas palabras " +
    "clave NO tienen fila propia porque el cashflow los suma en otra línea (p. ej. todas las nóminas en la línea «Nóminas»), así que " +
    "dejan de reportarse como «movimiento sin registrar». Úsala cuando el usuario explique que un tipo de movimiento ya está incluido " +
    "en una línea del cashflow («las nóminas de WOBA ya vienen sumadas en la línea Nóminas», «no me vuelvas a preguntar por las " +
    "nóminas»). accion='aprender' (por defecto) crea la regla; 'listar' muestra las reglas; 'quitar' elimina una por su id. No escribe " +
    "en Holded, el banco ni el cashflow: solo evita volver a preguntar. Nunca la uses para algo que el usuario NO explicó.",
  input_schema: {
    type: "object",
    properties: {
      accion: { type: "string", enum: ["aprender", "listar", "quitar"] },
      empresa: { type: "string", enum: ["WOBA", "EWORKS"], description: "Empresa a la que aplica (el cashflow cubre WOBA y EWORKS)." },
      palabras_clave: { type: "array", items: { type: "string" }, description: "Palabras del concepto bancario que identifican el tipo de movimiento (ej. ['nomina']). Una palabra genérica o un mes no sirve." },
      linea_cashflow: { type: "string", description: "Nombre de la línea del cashflow que ya los incluye (ej. 'Nóminas')." },
      explicacion: { type: "string", description: "Lo que explicó el usuario, tal cual." },
      tipo: { type: "string", enum: ["gasto", "ingreso"], description: "Por defecto gasto (cargos)." },
      id: { type: "string", description: "Id de la regla a quitar." },
    },
  },
  handler: async (input) => {
    const accion = typeof input.accion === "string" ? input.accion : "aprender";
    try {
      if (accion === "listar") {
        const reglas = await listarReglasAgregadas();
        return reglas.length === 0 ? "No hay reglas aprendidas." : reglas.map((r) => `- ${r.id} · ${r.empresa} · ${r.tipo === "ingreso" ? "abonos" : "cargos"} con «${r.palabrasClave.join(" + ")}» → «${r.lineaCashflow}»`).join("\n");
      }
      if (accion === "quitar") {
        const id = typeof input.id === "string" ? input.id.trim() : "";
        if (!id) return "Falta el id de la regla a quitar (pide 'listar' para verlo).";
        return (await quitarReglaAgregada(id)) ? `Regla ${id} eliminada: esos movimientos volverán a reportarse si no están en el cashflow.` : `No existe la regla ${id}.`;
      }
      const empresa = input.empresa;
      if (empresa !== "WOBA" && empresa !== "EWORKS") return "Error: 'empresa' debe ser WOBA o EWORKS (el cashflow no cubre otras).";
      const palabras = (Array.isArray(input.palabras_clave) ? input.palabras_clave : []).map((p) => normalizarTextoRegla(String(p))).filter((p) => p.length >= 4 && !/^\d+$/.test(p));
      if (palabras.length === 0) return "Error: hace falta al menos una palabra clave del concepto (4 letras o más, p. ej. 'nomina'). No se guardó nada.";
      const linea = typeof input.linea_cashflow === "string" ? input.linea_cashflow.trim() : "";
      const explicacion = typeof input.explicacion === "string" ? input.explicacion.trim() : "";
      if (!linea || !explicacion) return "Error: faltan la línea del cashflow y/o la explicación del usuario. No se guardó nada.";
      const regla = await registrarReglaAgregada({ empresa, palabrasClave: [...new Set(palabras)], lineaCashflow: linea, explicacion, tipo: input.tipo === "ingreso" ? "ingreso" : "gasto" });
      return `Regla ${regla.id} guardada: ${regla.empresa} · ${regla.tipo === "ingreso" ? "abonos" : "cargos"} con «${regla.palabrasClave.join(" + ")}» ya van sumados en «${regla.lineaCashflow}»; dejarán de reportarse como «sin registrar» (el informe indicará cuántos cubre). Para quitarla: accion='quitar' con id ${regla.id}.`;
    } catch (error) {
      return `No pude completar la operación con las reglas del cashflow: ${error instanceof Error ? error.message : String(error)}. No se cambió nada.`;
    }
  },
};
