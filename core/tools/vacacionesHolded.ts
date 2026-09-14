import { consultarVacacionesHoldedSeguras } from "../holded/hr";
import type { Empresa } from "../holded/client";
import { consultarPuenteVacaciones } from "../rrhh/vacacionesBridge";
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
    "por su API pública las solicitudes/aprobaciones, días usados ni el saldo restante; por eso la " +
    "herramienta contrasta el perfil con un puente restringido y actualizado desde Holded. Usa cifras " +
    "solo si el registro dice 'vigente'. Si hay homónimos, pregunta directamente a quien hizo la " +
    "solicitud por el nombre completo; no escales la ambigüedad a otra persona ni adivines.",
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
      ano: {
        type: "integer",
        minimum: 2020,
        maximum: 2100,
        description: "Año de vacaciones consultado. Opcional; por defecto usa el año actual.",
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

    const ano = typeof input.ano === "number" && Number.isInteger(input.ano) ? input.ano : new Date().getFullYear();
    if (ano < 2020 || ano > 2100) return "Error: 'ano' debe estar entre 2020 y 2100.";

    const consulta = await consultarVacacionesHoldedSeguras(empresa, personas);
    const identificados = consulta.resultados
      .filter((resultado) => resultado.estado === "encontrado" && resultado.nombre)
      .map((resultado) => resultado.nombre as string);
    const puente = identificados.length > 0
      ? await consultarPuenteVacaciones(empresa, identificados, ano)
      : { estado: "ok" as const, registros: [] };
    // consultarPuenteVacaciones conserva el orden solicitado. Usar el nombre
    // resuelto por Holded como clave evita que diferencias de mayúsculas o
    // tildes en la hoja hagan desaparecer un registro ya validado.
    const porNombre = new Map(
      identificados.map((nombre, index) => [nombre, puente.registros[index]])
    );
    const lineas = consulta.resultados.map((resultado) => {
      if (resultado.estado === "ambiguo") {
        return `- ${resultado.consulta}: coincidencia ambigua (${(resultado.candidatos ?? []).join(", ")}). ` +
          "Pregunta directamente a quien hizo la solicitud cuál es el nombre completo; no adivines.";
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
      const copia = porNombre.get(resultado.nombre ?? "");
      if (copia?.estado === "vigente") {
        const usados = copia.diasUsados == null ? "" : `, ${copia.diasUsados} usados`;
        return `- ${resultado.nombre}: ${politica}; ${copia.diasAsignados} asignados, ` +
          `${copia.diasSolicitadosPendientes} solicitados pendientes, ${copia.diasAprobados} aprobados` +
          `${usados} y ${copia.diasRestantes} restantes para ${ano}. ` +
          `Copia verificada de Holded actualizada ${copia.actualizadoEn}.`;
      }
      const estadoPuente = copia?.detalle ?? puente.detalle ?? "No hay un saldo exacto autorizado disponible.";
      return `- ${resultado.nombre}: ${politica}; ${anuales}. Saldo exacto: ${estadoPuente}`;
    });

    return [
      `Consulta RRHH de ${consulta.empresa} (solo datos mínimos de vacaciones):`,
      ...lineas,
      "",
      "La API pública identifica a la persona; los saldos exactos proceden exclusivamente del puente " +
        "restringido de Holded. Usa cifras solo cuando la línea indique que la copia está vigente.",
    ].join("\n");
  },
};
