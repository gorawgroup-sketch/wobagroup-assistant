import { listarProximosEventosHoldedConMeta } from "../holded/write";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";
import { notaFrescura } from "../utils/readCache";

const DIAS_POR_DEFECTO = 30;

/**
 * Solo lectura del calendario CRM de Holded (GET /events) — existía la
 * función (listarProximosEventosHolded en holded/write.ts, usada por el
 * dashboard /cerebro) pero nunca se había expuesto como herramienta de
 * chat. Sin esto, Claude no tenía forma de confirmar si una actividad
 * programada realmente aparecía en el calendario — pedido explícito tras
 * un caso real donde el usuario no veía una actividad "programada" y el
 * asistente no podía verificarlo por su cuenta.
 */
export const consultarEventosCalendarioTool: ToolDefinition = {
  name: "consultar_eventos_calendario",
  seguraParaModoRapido: true,
  lecturaAcotable: true,
  lecturaParalela: "holded",
  description:
    "Consulta las actividades/eventos ya programados en el calendario CRM de Holded (WOBA, EWORKS o " +
    "Footprint) en los próximos días. Úsala para confirmar si algo que se programó realmente quedó " +
    "creado, o cuando pregunten qué hay agendado. Nunca respondas que no puedes consultar el calendario " +
    "— usa esta herramienta. Solo lectura, nunca crea ni modifica nada (para eso usa " +
    "proponer_evento_calendario).",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa cuyo calendario se consulta." },
      dias: {
        type: "number",
        description: `Cuántos días hacia adelante revisar (desde hoy). Opcional, por defecto ${DIAS_POR_DEFECTO}.`,
      },
    },
    required: ["empresa"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }
    const dias = typeof input.dias === "number" && input.dias > 0
      ? Math.min(365, Math.floor(input.dias)) : DIAS_POR_DEFECTO;

    const lectura = await listarProximosEventosHoldedConMeta(empresa, dias);
    const eventos = lectura.datos;
    const responder = (texto: string) => `${texto}\n${notaFrescura(lectura.meta)}`;

    if (eventos.length === 0) {
      return responder(`No hay actividades programadas en el calendario de ${empresa} en los próximos ${dias} días.`);
    }

    return responder(
      `${eventos.length} actividad(es) programada(s) en el calendario de ${empresa} (próximos ${dias} días):\n\n` +
      eventos.map((e) => `- ${e.titulo} — ${e.fecha}`).join("\n")
    );
  },
};
