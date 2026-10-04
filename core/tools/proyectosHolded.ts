import {
  getProjectSummary,
  listProjects,
  matchProject,
  type Empresa,
  type HoldedProject,
  type HoldedProjectSummary,
} from "../holded/client";
import type { ToolDefinition } from "./types";

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

/** Importe tal como lo entrega Holded (moneda base de la empresa); no se asume ni convierte ninguna divisa. */
export function dinero(value: unknown): string {
  if (value === null || value === undefined || value === "") return "no disponible";
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return "no disponible";
  return parsed.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function resumenProyecto(empresa: Empresa, project: HoldedProject, summary: HoldedProjectSummary): string {
  const profitability = summary.profitability ?? {};
  const expenses = profitability.expenses ?? {};
  const economic = summary.economicStatus ?? {};
  const tasks = summary.projectEvolution?.tasks;

  return [
    `Proyecto: ${project.name}`,
    `Empresa: ${empresa}`,
    `ID: ${project.id}`,
    `Cliente: ${project.contact_name || "sin cliente vinculado"}`,
    `Estado: ${project.archived ? "archivado" : "activo/no archivado"}`,
    `Facturable: ${project.billable ? "sí" : "no"}`,
    `Inicio: ${project.start_date || "sin fecha"} · Fin: ${project.due_date || "sin fecha"}`,
    "",
    `Ventas/ingresos: ${dinero(profitability.sales)}`,
    `Gastos de documentos: ${dinero(expenses.documents)}`,
    `Coste de personal: ${dinero(expenses.personnel)}`,
    `Gastos totales: ${dinero(expenses.total)}`,
    `Beneficio: ${dinero(profitability.profit)}`,
    `Presupuestado/cotizado: ${dinero(economic.quoted)}`,
    `Facturado: ${dinero(economic.billed)}`,
    `Cobrado: ${dinero(economic.collected)}`,
    `Pendiente económico: ${dinero(economic.remaining)}`,
    tasks ? `Tareas: ${tasks.completed ?? 0}/${tasks.total ?? 0} completadas` : "Tareas: no disponible",
    "",
    "Nota de control: estos importes vienen del resumen agregado que entrega Holded, en la moneda base de la empresa. Los proyectos privados que solo ve un usuario en la web pueden no estar disponibles para la API y no se tratarán como inexistentes.",
  ].join("\n");
}

export const proyectosHoldedTool: ToolDefinition = {
  name: "consultar_proyectos_holded",
  seguraParaModoRapido: true,
  lecturaAcotable: true,
  lecturaParalela: "holded",
  description:
    "Lista los proyectos de Holded accesibles por API para WOBA, EWORKS o Footprint, o entrega el reporte " +
    "financiero de un proyecto (ventas/ingresos, gastos de documentos, personal, gastos totales, beneficio, " +
    "facturado, cobrado y pendiente). Úsala siempre que pregunten por proyectos, rentabilidad o ingresos/gastos " +
    "de un proyecto. Es solo lectura. Un proyecto que aparece en la web pero no aquí puede ser privado para un " +
    "usuario: nunca digas que no existe; explica que no está visible para la API.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: EMPRESAS, description: "Empresa cuyo Holded se consulta." },
      proyecto: {
        type: "string",
        description: "Nombre exacto, parte inequívoca del nombre o id del proyecto. Omitir para listar el catálogo.",
      },
      incluir_archivados: {
        type: "boolean",
        description: "Incluye proyectos archivados en el listado o la búsqueda. Por defecto false.",
      },
    },
    required: ["empresa"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (!EMPRESAS.includes(empresa)) return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";

    const includeArchived = input.incluir_archivados === true;
    const projects = await listProjects(empresa);
    // Copia: ordenar sobre la lista cacheada la mutaría para el resto de consultas.
    const visible = (includeArchived ? [...projects] : projects.filter((project) => !project.archived));
    const query = typeof input.proyecto === "string" ? input.proyecto.trim() : "";

    if (!query) {
      const lines = visible
        .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }))
        .map((project) => `- ${project.name} [${project.id}]${project.billable ? " · facturable" : ""}`);
      return [
        `${visible.length} proyecto(s) ${includeArchived ? "visibles" : "activos/no archivados"} por API en Holded (${empresa}):`,
        "",
        ...lines,
        "",
        `El catálogo completo visible para la API contiene ${projects.length} proyecto(s). Si un proyecto aparece en la web de Holded pero no aquí, probablemente es privado para un usuario; no significa que no exista.`,
      ].join("\n");
    }

    const match = matchProject(projects, query, includeArchived);
    const selected = match.exact ?? (match.candidates.length === 1 ? match.candidates[0] : undefined);
    if (!selected) {
      if (match.candidates.length > 1) {
        return (
          `Encontré varias posibilidades en ${empresa}; necesito el nombre exacto o el id para no mezclar proyectos:\n` +
          match.candidates.map((project) => `- ${project.name} [${project.id}]`).join("\n")
        );
      }
      return (
        `No encontré "${query}" dentro de los proyectos que la API puede ver en ${empresa}. ` +
        `No afirmo que no exista: puede ser un proyecto privado visible solo en la interfaz web de un usuario. ` +
        `Hay que cambiar su visibilidad/permisos en Holded antes de automatizarlo.`
      );
    }

    const summary = await getProjectSummary(empresa, selected.id);
    return resumenProyecto(empresa, selected, summary);
  },
};
