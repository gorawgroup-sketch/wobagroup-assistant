import { consultarAgenteSeguros } from "../seguros/agente/agente";
import { consultarPolizasSeguroTool } from "./consultarPolizasSeguro";
import type { ToolContext, ToolDefinition } from "./types";

/** Cabecera que acompaña a la respuesta del especialista para que Wobi la transmita sin recortarla. */
export const CABECERA_RESPUESTA_AGENTE =
  "[Respuesta de Wobi Seguros, el especialista de seguros de Wobi. Transmítela a la persona tal cual (puedes ajustar el saludo y el tono); " +
  "no quites cifras, fechas, fuentes ni avisos, y no añadas datos de seguros que no estén aquí.]";

export interface DepsRespuestaAgente {
  consultar(peticion: { pregunta: string; contexto?: string; chatId?: number }): Promise<{ texto: string }>;
  respaldo(context?: ToolContext): Promise<string> | string;
}

/** La respuesta del especialista, o —si no puede— el registro crudo con el aviso de que no hay análisis. Exportada para probar el respaldo. */
export async function responderConPuertaUnica(
  peticion: { pregunta: string; contexto?: string; chatId?: number },
  context: ToolContext | undefined,
  deps: DepsRespuestaAgente
): Promise<string> {
  try {
    const respuesta = await deps.consultar(peticion);
    return `${CABECERA_RESPUESTA_AGENTE}\n\n${respuesta.texto}`;
  } catch (error) {
    const motivo = error instanceof Error ? error.message : String(error);
    console.error("[consultarAgenteSeguros] El especialista no pudo responder; se devuelven los datos crudos del registro:", motivo);
    const registro = await deps.respaldo(context);
    return (
      `[Wobi Seguros no está disponible ahora para analizar la pregunta (${motivo.slice(0, 200)}). Dile a la persona que esto son solo los datos del registro, sin análisis, ` +
      `y que puede repetir la pregunta en unos minutos.]\n\n${registro}`
    );
  }
}

/**
 * Puerta única del chat principal hacia Wobi Seguros (docs/wobi-seguros.md §6.5, decisión de Carlos del 18/09/2026:
 * un especialista independiente, invocado desde el mismo hilo). Wobi no razona sobre seguros: pasa la pregunta, el
 * especialista contesta con su propio prompt, su memoria y sus herramientas, y Wobi lo transmite.
 *
 * Si el especialista no puede responder (IA bloqueada por la política, caída de la API…), no se queda sin respuesta:
 * devuelve los datos crudos del registro con el aviso de que no hay análisis.
 */
export const consultarAgenteSegurosTool: ToolDefinition = {
  name: "consultar_agente_seguros",
  // Disponible también en el modo rápido y en las sesiones web de solo lectura, a propósito: es la ÚNICA puerta de seguros en
  // esos modos (la herramienta cruda ya no lo está), así que sin esto esas sesiones se quedarían sin poder preguntar por
  // seguros. No incumple el sentido de la marca: el especialista solo tiene herramientas de escritura si quien pregunta es
  // administrador y cita su frase literal, y todo lo que escribe es idempotente (repetir la misma petición no duplica nada),
  // así que un turno que se reinicia no puede dejar nada a medias. Una sesión de solo lectura no tiene identidad de
  // administrador y, por tanto, solo lee.
  seguraParaModoRapido: true,
  description:
    "Wobi Seguros: el ESPECIALISTA de seguros del grupo (WOBA, EWORKS, Footprint). Úsalo para CUALQUIER tema de seguros: qué pólizas hay y cómo están, qué cubre algo, franquicias y límites, " +
    "si una situación está cubierta, vencimientos y próximos pagos, si un recibo está pagado o devuelto, qué falta pedirle a la correduría (Acodrid), qué hay de nuevo en el banco o el correo sobre seguros, " +
    "y también para pedirle que anote algo (una decisión, un pago que ya se hizo). Tiene su propia memoria (decisiones de Carlos, contactos, asuntos pendientes), lee el banco, el correo y los documentos de las pólizas, " +
    "y actualiza el registro cuando la persona se lo pide. NO razones tú sobre seguros ni respondas de memoria: pásale la pregunta. En `pregunta` pon el mensaje de la persona TAL CUAL lo escribió " +
    "(literal, sin reescribirlo ni resumirlo: si pide un cambio en el registro, el especialista solo lo hace citando sus palabras exactas). En `contexto`, si hace falta, 1-3 frases de la conversación. " +
    "Tarda entre 10 y 40 segundos. Transmite su respuesta completa, sin recortar cifras, fechas, fuentes ni avisos.",
  input_schema: {
    type: "object",
    properties: {
      pregunta: { type: "string", description: "El mensaje de la persona sobre seguros, literal." },
      contexto: { type: "string", description: "Opcional: 1-3 frases de la conversación que ayuden a entender la pregunta." },
    },
    required: ["pregunta"],
  },
  handler: async (input, context) => {
    const pregunta = typeof input.pregunta === "string" ? input.pregunta.trim() : "";
    if (!pregunta) return "Error: falta la pregunta para Wobi Seguros.";
    const contexto = typeof input.contexto === "string" ? input.contexto : undefined;
    return responderConPuertaUnica({ pregunta, contexto, chatId: context?.chatId }, context, {
      // Import perezoso: depsReales arrastra el cliente de Claude, que a su vez importa este registro (ciclo al cargar).
      consultar: async (peticion) => {
        const { depsRealesAgente } = await import("../seguros/agente/depsReales");
        return consultarAgenteSeguros(peticion, depsRealesAgente());
      },
      respaldo: (ctx) => consultarPolizasSeguroTool.handler({}, ctx),
    });
  },
};
