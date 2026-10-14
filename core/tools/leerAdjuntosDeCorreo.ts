import { leerAdjuntosParaClasificador, seccionAdjuntos } from "../correo/lectura/adjuntos";
import { buscarMensajes, obtenerResumenCorreo } from "../gmail/client";
import type { ToolDefinition } from "./types";

/**
 * Lee el CONTENIDO de los adjuntos de un correo (Excel, Word, texto, CSV; sin IA) para poder actuar sobre él desde el chat, p. ej. una tabla de liquidaciones de la
 * gestoría. Solo lectura: no archiva, no procesa como gasto y no marca nada como leído.
 */
export const leerAdjuntosDeCorreoTool: ToolDefinition = {
  name: "leer_adjuntos_de_correo",
  description:
    "Lee el contenido de los adjuntos (Excel, Word, texto, CSV) del correo más reciente que coincida con la búsqueda, también si ya está leído, y lo devuelve como texto " +
    "para que lo interpretes: por ejemplo la tabla de liquidaciones de impuestos que manda la gestoría, antes de proponer registrarla con proponer_lote_impuestos_cashflow. " +
    "NO archiva ni procesa como gasto el adjunto: solo lo lee. `busqueda` puede ser una consulta de Gmail («from:lola subject:liquidaciones», «3T Impuestos») o palabras del asunto " +
    "o del adjunto. PDF e imágenes no se leen aquí (solo se indica que existen).",
  input_schema: {
    type: "object",
    properties: { busqueda: { type: "string", description: "Consulta de Gmail o palabras del asunto/adjunto del correo." } },
    required: ["busqueda"],
  },
  handler: async (input) => {
    const busqueda = typeof input.busqueda === "string" ? input.busqueda.trim() : "";
    if (busqueda.length < 3) return "Error: falta la búsqueda del correo.";
    const ids = await buscarMensajes(`in:anywhere ${busqueda}`, 5);
    if (ids.length === 0) return `No encontré ningún correo para «${busqueda}».`;
    // El más reciente que traiga adjuntos.
    for (const id of ids) {
      const correo = await obtenerResumenCorreo(id);
      if (!correo.adjuntos?.length) continue;
      const lecturas = await leerAdjuntosParaClasificador(correo.id, correo.adjuntos);
      return [`Correo «${correo.asunto}» de ${correo.de} (${correo.fecha}).`, seccionAdjuntos(lecturas)].join("\n\n");
    }
    return `Encontré ${ids.length} correo(s) para «${busqueda}», pero ninguno trae adjuntos.`;
  },
};
