import { fetchDetalleRegistros } from "../google/cashflowSheet";
import type { ToolDefinition } from "./types";

/**
 * Lee los movimientos de detalle de la hoja DATOS (ingresos, pagos a proyectos,
 * pagos extras y aplazamientos de impuestos), filtrables por semana, empresa
 * dueña del movimiento y/o contraparte (cliente/proveedor).
 *
 * "empresa" y "contraparte" son conceptos distintos y no deben mezclarse:
 * - empresa: WOBA o EWORKS, la entidad del grupo dueña del movimiento (viene
 *   de la columna de tag; solo existe en Ingresos y Pagos Proyectos).
 * - contraparte: texto libre con el nombre de quien paga o cobra, que puede
 *   incluir nombres de otras empresas del grupo (ej. "Footprint" aparece como
 *   cliente dentro del cashflow de WOBA/EWORKS).
 *
 * NO incluye gastos fijos ni pagos pendientes de Alberto / deudas pendientes.
 */
export const cashflowDetalleTool: ToolDefinition = {
  name: "consultar_cashflow_detalle",
  seguraParaModoRapido: true,
  description:
    "Consulta el detalle de movimientos del cashflow (ingresos, pagos a proyectos, pagos extras y " +
    "aplazamientos de impuestos) desde la hoja DATOS. No incluye gastos fijos ni pagos pendientes de " +
    "Alberto ni deudas pendientes. Úsala cuando el usuario pida un desglose detallado en vez de solo " +
    "el resumen semanal.",
  input_schema: {
    type: "object",
    properties: {
      semana: {
        type: "string",
        description: "Filtra por semana exacta, formato 'S38'. Opcional.",
      },
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
        description:
          "Filtra por la empresa del grupo DUEÑA del movimiento (WOBA o EWORKS), no por el nombre " +
          "del cliente/proveedor. Solo aplica a movimientos de Ingresos y Pagos a Proyectos, que son " +
          "los únicos con esa clasificación. Opcional.",
      },
      contraparte: {
        type: "string",
        description:
          "Filtra por el nombre de quien paga o cobra (cliente, proveedor o concepto), coincidencia " +
          "parcial sin distinguir mayúsculas/minúsculas. Puede incluir nombres de otras empresas del " +
          "grupo si aparecen como cliente/proveedor (ej. 'Footprint'). No confundir con 'empresa'. " +
          "Opcional.",
      },
    },
  },
  handler: async (input) => {
    const registros = await fetchDetalleRegistros();

    const semanaFiltro = typeof input.semana === "string" ? input.semana.trim().toUpperCase() : undefined;
    const empresaFiltro = typeof input.empresa === "string" ? input.empresa.trim().toUpperCase() : undefined;
    const contraparteFiltro =
      typeof input.contraparte === "string" ? input.contraparte.trim().toLowerCase() : undefined;

    const filtrados = registros.filter((r) => {
      if (semanaFiltro && r.semana.toUpperCase() !== semanaFiltro) return false;

      if (empresaFiltro && r.empresa !== empresaFiltro) return false;

      if (contraparteFiltro) {
        const texto = [r.cliente, r.proyecto, r.concepto].filter(Boolean).join(" ").toLowerCase();
        if (!texto.includes(contraparteFiltro)) return false;
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
        const empresaTag = r.empresa ? ` [${r.empresa}]` : "";
        return `[${r.categoria}]${empresaTag} ${nombre}${proyecto} — ${r.semana} — ${r.valor}`;
      })
      .join("\n");
  },
};
