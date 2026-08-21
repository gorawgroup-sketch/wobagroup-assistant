import { fetchDetalleRegistros } from "../google/cashflowSheet";
import type { ToolDefinition } from "./types";

/**
 * Lee los movimientos de detalle de la hoja DATOS (ingresos, pagos a proyectos,
 * pagos extras y aplazamientos de impuestos), filtrables por semana y/o empresa.
 * NO incluye gastos fijos ni pagos pendientes de Alberto / deudas pendientes.
 * Pensado para alimentar un dashboard con desglose por categoría.
 */
export const cashflowDetalleTool: ToolDefinition = {
  name: "consultar_cashflow_detalle",
  description:
    "Consulta el detalle de movimientos del cashflow (ingresos, pagos a proyectos, pagos extras y " +
    "aplazamientos de impuestos) desde la hoja DATOS, filtrable por semana y/o por empresa/cliente. " +
    "No incluye gastos fijos ni pagos pendientes de Alberto ni deudas pendientes. Úsala cuando el " +
    "usuario pida un desglose detallado en vez de solo el resumen semanal.",
  input_schema: {
    type: "object",
    properties: {
      semana: {
        type: "string",
        description: "Filtra por semana exacta, formato 'S38'. Opcional.",
      },
      empresa: {
        type: "string",
        description:
          "Filtra por nombre de cliente, proyecto o concepto (coincidencia parcial, sin distinguir " +
          "mayúsculas/minúsculas). Opcional.",
      },
    },
  },
  handler: async (input) => {
    const registros = await fetchDetalleRegistros();

    const semanaFiltro = typeof input.semana === "string" ? input.semana.trim().toUpperCase() : undefined;
    const empresaFiltro = typeof input.empresa === "string" ? input.empresa.trim().toLowerCase() : undefined;

    const filtrados = registros.filter((r) => {
      if (semanaFiltro && r.semana.toUpperCase() !== semanaFiltro) return false;

      if (empresaFiltro) {
        const texto = [r.cliente, r.proyecto, r.concepto].filter(Boolean).join(" ").toLowerCase();
        if (!texto.includes(empresaFiltro)) return false;
      }

      return true;
    });

    if (filtrados.length === 0) {
      return "No se encontraron movimientos que coincidan con esos filtros.";
    }

    return filtrados
      .map((r) => {
        const nombre = r.cliente ?? r.concepto ?? "(sin nombre)";
        const proyecto = r.proyecto ? ` / ${r.proyecto}` : "";
        return `[${r.categoria}] ${nombre}${proyecto} — ${r.semana} — ${r.valor}`;
      })
      .join("\n");
  },
};
