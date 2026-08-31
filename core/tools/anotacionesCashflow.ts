import { obtenerAnotacionesCashflow } from "../google/cashflowComments";
import type { ToolDefinition } from "./types";

/**
 * Expone los comentarios reales de Google Sheets (columna VALOR de Pagos
 * Proyectos, Ingresos, etc.) — Carlos y su equipo los usan para dejar
 * contexto de cobro/pago ("se paga solo cuando recibamos X", "avisar al
 * proveedor", "cobra a finales de agosto"). El tool solo entrega los datos
 * ya ubicados en su fila real — la recomendación de cómo proceder la da
 * Claude al responder, usando su propio juicio sobre el contenido (fechas
 * mencionadas, condiciones, urgencia), no una regla fija acá.
 */
export const anotacionesCashflowTool: ToolDefinition = {
  name: "consultar_anotaciones_cashflow",
  seguraParaModoRapido: true,
  description:
    "Lee los comentarios reales de Google Sheets (no las 'notas' clásicas) que hay en el Sheet de cashflow " +
    "— el equipo los usa en la columna VALOR de Pagos Proyectos, Ingresos, etc. para dejar contexto de " +
    "cobro/pago que no está en ninguna otra parte (ej. 'se paga solo cuando recibamos el primer pago de " +
    "X', 'avisar al proveedor', 'cobra a finales de agosto'). Úsala cuando pregunten por anotaciones, " +
    "comentarios, o notas del cashflow, o cuando conviene revisar si hay contexto oculto detrás de un " +
    "monto antes de dar una recomendación. Por cada una da: categoría/cliente/proyecto/semana/empresa (si " +
    "se pudo ubicar la fila — si no, dilo explícitamente, el comentario puede estar 'huérfano' porque la " +
    "fila cambió desde que se dejó), quién lo escribió, cuándo, el texto, y si tiene respuestas. Con esa " +
    "información, da tu propia recomendación de cómo proceder (cuándo pagar, qué verificar en Holded, a " +
    "quién avisar) — no te limites a repetir el comentario.",
  input_schema: {
    type: "object",
    properties: {
      incluir_resueltos: {
        type: "boolean",
        description: "Si es true, incluye también los comentarios ya marcados como resueltos. Opcional, por defecto false (solo pendientes).",
      },
    },
  },
  handler: async (input) => {
    const soloSinResolver = input.incluir_resueltos !== true;
    const anotaciones = await obtenerAnotacionesCashflow(soloSinResolver);

    if (anotaciones.length === 0) {
      return soloSinResolver
        ? "No hay anotaciones (comentarios) pendientes en el Sheet de cashflow."
        : "No hay ninguna anotación (comentario) en el Sheet de cashflow.";
    }

    const lineas = anotaciones.map((a) => {
      const ubicacion = a.registro
        ? `${a.registro.categoria}${a.registro.empresa ? ` (${a.registro.empresa})` : ""} — ${
            a.registro.cliente || a.registro.concepto || "(sin nombre)"
          }${a.registro.proyecto ? ` / ${a.registro.proyecto}` : ""} — semana ${a.registro.semana || "?"}`
        : "⚠️ no se pudo ubicar la fila actual (el valor de la celda ya no coincide con ningún registro — puede ser un comentario huérfano de una fila cambiada/pagada)";

      const respuestas = a.respuestas.length > 0 ? `\n  Respuestas: ${a.respuestas.map((r) => `${r.autor}: "${r.contenido}"`).join(" | ")}` : "";
      const estado = a.resuelto ? " [RESUELTO]" : "";

      return (
        `- Valor: ${a.valorCelda}${estado}\n` +
        `  Ubicación: ${ubicacion}\n` +
        `  ${a.autor} (${a.creado.slice(0, 10)}): "${a.contenido}"${respuestas}`
      );
    });

    return `${anotaciones.length} anotación(es) encontrada(s) en el Sheet de cashflow:\n\n${lineas.join("\n\n")}`;
  },
};
