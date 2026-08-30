import { fetchDetalleRegistros } from "../google/cashflowSheet";
import { textosParecidos } from "../utils/textoParecido";
import type { ToolDefinition } from "./types";

/**
 * Lee los movimientos de detalle de la hoja DATOS: ingresos, pagos a proyectos,
 * pagos extras, aplazamientos de impuestos, gastos fijos (nóminas, créditos,
 * servicios, consultores, impuestos) y pendientes (Alberto / deudas con
 * otros) — filtrables por semana, empresa dueña del movimiento y/o
 * contraparte (cliente/proveedor/concepto).
 *
 * "empresa" y "contraparte" son conceptos distintos y no deben mezclarse:
 * - empresa: WOBA o EWORKS, la entidad del grupo dueña del movimiento (viene
 *   de la columna de tag; solo existe en Ingresos y Pagos Proyectos — el
 *   resto de categorías no tiene ese tag, así que filtrar por empresa las
 *   excluye siempre).
 * - contraparte: texto libre con el nombre de quien paga o cobra, o el
 *   concepto del gasto (ej. "Limpieza", "Google", "Renting"), que puede
 *   incluir nombres de otras empresas del grupo (ej. "Footprint" aparece como
 *   cliente dentro del cashflow de WOBA/EWORKS).
 */
export const cashflowDetalleTool: ToolDefinition = {
  name: "consultar_cashflow_detalle",
  seguraParaModoRapido: true,
  description:
    "Consulta el detalle de movimientos del cashflow desde la hoja DATOS: ingresos, pagos a proyectos, " +
    "pagos extras, aplazamientos de impuestos, gastos fijos (nóminas, créditos, servicios como limpieza/" +
    "renting/alquiler, consultores, impuestos) y pendientes (pagos pendientes a Alberto, deudas con " +
    "otros). Para buscar un concepto o proveedor concreto (ej. '¿hay facturas de limpieza pendientes?') " +
    "usa el filtro 'contraparte' con ese texto — cubre TODAS las categorías, no asumas que algo 'no está' " +
    "sin haber buscado aquí primero. La búsqueda por contraparte es tolerante (encuentra 'Seguridad " +
    "social' aunque la fila real diga 'Impuestos seg social') — si el resultado viene marcado como " +
    "coincidencia APROXIMADA, dilo así al usuario y pregunta si es lo que buscaba, no lo des por hecho. " +
    "Úsala cuando el usuario pida un desglose detallado en vez de solo el resumen semanal.",
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

    const conFiltrosBase = registros.filter((r) => {
      if (semanaFiltro && r.semana.toUpperCase() !== semanaFiltro) return false;
      if (empresaFiltro && r.empresa !== empresaFiltro) return false;
      return true;
    });

    let filtrados = conFiltrosBase;
    let aproximado = false;

    if (contraparteFiltro) {
      const textoDe = (r: (typeof conFiltrosBase)[number]) =>
        [r.cliente, r.proyecto, r.concepto].filter(Boolean).join(" ").toLowerCase();

      const exactos = conFiltrosBase.filter((r) => textoDe(r).includes(contraparteFiltro));

      if (exactos.length > 0) {
        filtrados = exactos;
      } else {
        // Sin match exacto: cae a comparación por palabras parecidas (ej.
        // "Seguridad social" → "Impuestos seg social") en vez de decir "no
        // encontré nada" cuando el dato sí existe con otra redacción.
        // Nunca se afirma como certeza — se marca "aproximado" para que
        // quien reciba la respuesta confirme antes de darlo por sentado.
        filtrados = conFiltrosBase.filter((r) => textosParecidos(contraparteFiltro, textoDe(r)));
        aproximado = filtrados.length > 0;
      }
    }

    if (filtrados.length === 0) {
      return "No se encontraron movimientos que coincidan con esos filtros.";
    }

    const lineas = filtrados
      .map((r) => {
        const nombre = r.cliente ?? r.concepto ?? "(sin nombre)";
        const proyecto = r.proyecto ? ` / ${r.proyecto}` : "";
        const empresaTag = r.empresa ? ` [${r.empresa}]` : "";
        const bancoTag = r.banco ? ` (${r.banco})` : "";
        const semana = r.semana || "(sin semana)";
        return `[${r.categoria}]${empresaTag} ${nombre}${proyecto} — ${semana} — ${r.valor}${bancoTag}`;
      })
      .join("\n");

    if (!aproximado) return lineas;

    return (
      `⚠️ COINCIDENCIA APROXIMADA (no encontré "${input.contraparte}" tal cual — esto es lo más parecido, ` +
      `confírmalo con el usuario antes de darlo por hecho):\n\n${lineas}`
    );
  },
};
