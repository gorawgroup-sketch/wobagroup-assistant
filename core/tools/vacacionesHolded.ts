import { consultarVacacionesHoldedSeguras } from "../holded/hr";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

export const vacacionesHoldedTool: ToolDefinition = {
  name: "consultar_vacaciones_holded",
  seguraParaModoRapido: true,
  lecturaAcotable: true,
  lecturaParalela: "holded",
  description:
    "Consulta de forma segura y de solo lectura el perfil de RRHH y la información de vacaciones que " +
    "la API pública de Holded realmente expone para hasta 5 personas. Úsala cuando pregunten por " +
    "vacaciones, ausencias, días solicitados, aprobados o restantes. Busca por persona y empresa; si " +
    "hay homónimos pide el nombre completo, nunca elijas uno por intuición. La herramienta nunca devuelve " +
    "nómina, salario, documento, IBAN, dirección ni otros datos personales. Importante: Holded no expone " +
    "por su API pública las solicitudes/aprobaciones, días usados ni el saldo restante; si el resultado " +
    "lo indica, explícalo con precisión y no inventes ni calcules el saldo.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: EMPRESAS,
        description: "Empresa de Holded donde trabajan las personas.",
      },
      personas: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string" },
        description: "Nombres de las personas. Incluye apellido cuando sea conocido para evitar homónimos.",
      },
    },
    required: ["empresa", "personas"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (!EMPRESAS.includes(empresa)) return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";

    const personas = Array.isArray(input.personas)
      ? input.personas.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    if (personas.length === 0) return "Error: indica al menos una persona.";
    if (personas.length > 5) return "Error: se pueden consultar como máximo 5 personas a la vez.";

    const consulta = await consultarVacacionesHoldedSeguras(empresa, personas);
    const lineas = consulta.resultados.map((resultado) => {
      if (resultado.estado === "ambiguo") {
        return `- ${resultado.consulta}: coincidencia ambigua (${(resultado.candidatos ?? []).join(", ")}). ` +
          "Pide el nombre completo; no adivines.";
      }
      if (resultado.estado !== "encontrado") {
        return `- ${resultado.consulta}: ${resultado.detalle}`;
      }
      const politica = resultado.politicaAusenciasConfigurada
        ? "política de ausencias asignada"
        : "sin política de ausencias visible";
      const anuales = resultado.diasAnualesContrato == null
        ? "días anuales no expuestos/configurados en el contrato API"
        : `${resultado.diasAnualesContrato} días anuales en contrato`;
      return `- ${resultado.nombre}: ${politica}; ${anuales}.`;
    });

    return [
      `Consulta RRHH de ${consulta.empresa} (solo datos mínimos de vacaciones):`,
      ...lineas,
      "",
      "Límite verificado del proveedor: la API pública de Holded no ofrece solicitudes de ausencia, " +
        "aprobaciones, días usados ni saldo restante. No afirmes una cifra exacta sin una fuente adicional autorizada.",
    ].join("\n");
  },
};
