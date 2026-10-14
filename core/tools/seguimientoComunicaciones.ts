import { textoSeguimientoCompleto } from "../jobs/seguimientoComunicaciones";
import type { ToolDefinition } from "./types";

/**
 * Lo que han enviado o contestado las personas a las que se escribió con proponer_correo_a_audiencia (core/comunicaciones/): quién escribió, con
 * qué asunto y adjuntos, qué hizo el sistema con cada adjunto y quién sigue sin responder. Solo lectura. El mismo resumen llega solo, con novedades,
 * por la mañana y por la tarde de los días laborables (core/jobs/seguimientoComunicaciones.ts).
 */
export const seguimientoComunicacionesTool: ToolDefinition = {
  name: "seguimiento_comunicaciones",
  description:
    "Resume lo que han contestado o enviado las personas a las que se les mandó un correo a una audiencia (proponer_correo_a_audiencia) en los últimos 14 días: " +
    "quién ha escrito, con qué asunto y adjuntos, qué pasó con cada adjunto (ya es gasto en Holded, propuesta pendiente, descartado o sin procesar), si el asunto " +
    "lleva el formato pedido y quién todavía no ha escrito. Úsala cuando pregunten «¿cómo va el seguimiento?», «¿quién ha respondido?», «¿qué han mandado?» " +
    "sobre un envío masivo. Solo lectura: no procesa ni responde nada. `comunicacion` filtra por id o por texto del asunto; sin filtro, las más recientes.",
  input_schema: {
    type: "object",
    properties: { comunicacion: { type: "string", description: "Id o texto del asunto/descripción de la comunicación. Opcional." } },
  },
  handler: async (input) => textoSeguimientoCompleto(typeof input.comunicacion === "string" ? input.comunicacion : undefined),
};
