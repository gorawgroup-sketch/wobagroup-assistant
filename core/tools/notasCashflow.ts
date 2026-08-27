import { guardarNotaCashflow, buscarNotasCashflow } from "../cashflow/notasCashflowSheet";
import type { ToolDefinition } from "./types";

/**
 * Guarda una observación/instrucción sobre un gasto o ingreso ESPECÍFICO del
 * cashflow (ej. "el gasto de Robar 1076,90 se paga cuando haya plata, se va
 * moviendo semana a semana"). Se guarda directo, sin botón — es información,
 * no una escritura financiera real (no mueve dinero ni cambia el cashflow
 * en Holded/Sheets), mismo criterio que registrar_correccion.
 */
export const guardarNotaCashflowTool: ToolDefinition = {
  name: "guardar_nota_cashflow",
  description:
    "Guarda una nota/observación permanente asociada a un gasto o ingreso específico del cashflow " +
    "(identificado por concepto y monto), para que quede disponible cuando pregunten qué hacer con ese " +
    "gasto/ingreso más adelante. Úsala de inmediato cuando el usuario te dé una instrucción u observación " +
    "sobre un gasto o ingreso puntual (ej. 'esto se paga cuando haya plata', 'esto lo vamos moviendo " +
    "semana a semana', 'este ingreso es de un cliente que paga tarde') — no esperes a que lo pida " +
    "explícitamente, igual que con las correcciones.",
  input_schema: {
    type: "object",
    properties: {
      concepto: {
        type: "string",
        description: "Concepto o descripción del gasto/ingreso tal como se menciona (ej. 'Robar', 'UNIQUE', 'BANAHOSTING').",
      },
      valor: {
        type: "number",
        description: "Monto exacto del gasto/ingreso, siempre en positivo sin importar si es gasto o ingreso (ej. 1076.90).",
      },
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint"],
        description: "Empresa a la que corresponde, si se sabe o se puede inferir del contexto.",
      },
      nota: {
        type: "string",
        description: "La observación/instrucción, tal cual la dio el usuario (no la resumas de más, conserva el detalle real).",
      },
    },
    required: ["concepto", "valor", "nota"],
  },
  handler: async (input, context) => {
    const concepto = typeof input.concepto === "string" ? input.concepto.trim() : "";
    const valor = typeof input.valor === "number" ? input.valor : Number(input.valor);
    const nota = typeof input.nota === "string" ? input.nota.trim() : "";
    const empresa = typeof input.empresa === "string" ? input.empresa : undefined;

    if (!concepto || !nota || !Number.isFinite(valor)) {
      return "Error: faltan datos (concepto, valor numérico o nota) para guardar la observación.";
    }

    try {
      const registro = await guardarNotaCashflow({ concepto, valor, empresa, nota, autor: `chat (${context?.chatId ?? "?"})` });
      return `Guardado — nota asociada a "${registro.concepto}" (${registro.valor.toFixed(2)}€${registro.empresa ? `, ${registro.empresa}` : ""}).`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error guardando la nota: ${message}. No se guardó nada — avísale al usuario explícitamente, nunca confirmes un guardado que no ocurrió.`;
    }
  },
};

/**
 * Busca notas guardadas sobre un gasto/ingreso específico, por concepto y/o
 * monto. Solo lectura — segura para el modo rápido de Haiku.
 */
export const consultarNotasCashflowTool: ToolDefinition = {
  name: "consultar_notas_cashflow",
  seguraParaModoRapido: true,
  description:
    "Busca notas/observaciones ya guardadas sobre un gasto o ingreso específico del cashflow, por " +
    "concepto y/o monto. Úsala SIEMPRE que pregunten 'qué hacemos con...', 'qué dijimos de...', 'qué " +
    "pasa con el gasto/ingreso de...', o cualquier cosa sobre un gasto/ingreso puntual — antes de " +
    "responder solo con los datos crudos del cashflow, revisa si hay una observación guardada.",
  input_schema: {
    type: "object",
    properties: {
      concepto: { type: "string", description: "Concepto o parte del concepto a buscar (ej. 'Robar')." },
      valor: { type: "number", description: "Monto a buscar, si se conoce (ej. 1076.90) — ayuda a precisar cuando hay conceptos repetidos." },
    },
  },
  handler: async (input) => {
    const concepto = typeof input.concepto === "string" ? input.concepto.trim() : undefined;
    const valor = typeof input.valor === "number" ? input.valor : undefined;

    if (!concepto && valor === undefined) {
      return "Error: da al menos un concepto o un monto para buscar.";
    }

    const resultados = await buscarNotasCashflow({ concepto, valor });
    if (resultados.length === 0) {
      return "No hay ninguna nota guardada sobre ese gasto/ingreso todavía.";
    }

    return resultados
      .map(
        (n) =>
          `"${n.concepto}" (${n.valor.toFixed(2)}€${n.empresa ? `, ${n.empresa}` : ""}) — ${n.nota} ` +
          `[guardado ${n.creadoEn.slice(0, 10)}]`
      )
      .join("\n");
  },
};
