import { listarAudiencias } from "../comunicaciones/audiencias";
import { listarPeticion, prepararEnvioMasivo, type PeticionEnvio } from "../comunicaciones/envioMasivoTelegram";
import type { ToolDefinition } from "./types";

/**
 * Un mismo correo a VARIAS personas (una audiencia), siguiendo la orden de quien lo pide. Caso de origen (Carlos, 2026-10-14): escribir a todos los
 * que ya recibieron una solicitud de soportes para agradecer y explicar cómo enviarlos; el asistente decía que «no podía mezclarlo» porque solo
 * existía un proceso específico para pedir cargos nuevos. Esta herramienta es general: el chat redacta el texto según la orden, la audiencia sale de un
 * registro del sistema (ver core/comunicaciones/audiencias.ts, ampliable) y NADA se envía hasta que un superadministrador pulse «Enviar».
 */
export const proponerCorreoAAudienciaTool: ToolDefinition = {
  name: "proponer_correo_a_audiencia",
  description:
    "Prepara UN mismo correo para VARIAS personas a la vez (una audiencia que ya existe en los registros del sistema) y lo muestra por Telegram con los " +
    "botones «Ver correo» / «Enviar» / «Cancelar»; no envía nada hasta que un superadministrador pulse «Enviar». Úsala cuando pidan escribir, avisar, " +
    "recordar, agradecer o aclarar algo a un grupo de personas («a todos los que…», «a toda esa base», «a los que ya se les pidió…»): nunca digas que no puedes " +
    "mandar un correo masivo ni uses proponer_envio_correo en un bucle (esa es para UN destinatario). TÚ redactas el asunto y el cuerpo siguiendo la orden " +
    "del usuario (español, tono profesional y corporativo, claro y conciso, con saludo y despedida; no inventes datos). Puedes usar las marcas {nombre} (nombre de pila), " +
    "{nombre_completo}, {empresas} y {detalle} (texto propio de cada persona, solo con la audiencia «lista» y `detalle` en cada destinatario): se sustituyen por persona. Elige la audiencia que corresponda y pasa sus parámetros; las audiencias salen de los registros del " +
    "sistema y solo incluyen personas con email que consta (nunca se adivina uno). Con solo_listar=true no se prepara nada: te dice a quién iría (úsalo para " +
    "contestar «¿a quién se lo enviarías?»). Si el usuario quiere dejar fuera a alguien (por ejemplo, a sí mismo), pasa su nombre y apellido en `excluir`. " +
    `Audiencias disponibles: ${listarAudiencias().map((a) => `«${a.id}» — ${a.descripcion} Parámetros: ${a.parametros}.`).join(" ")} ` +
    "Si una instrucción trata de soportes de gastos con tarjeta, el formato que se pide a quien los envía está en la regla del proceso de soportes (cada soporte en un " +
    "correo aparte y nuevo a asistente@wobagroup.com, sin responder a la solicitud; asunto con el detalle del gasto, el valor, la moneda y la empresa; documento original adjunto).",
  input_schema: {
    type: "object",
    properties: {
      audiencia: { type: "string", enum: listarAudiencias().map((a) => a.id), description: "Id de la audiencia a la que se escribe." },
      parametros: { type: "object", description: "Parámetros de la audiencia (por ejemplo { empresa: \"Footprint\" } o { dominio: \"footprint.global\" } o { destinatarios: [{ nombre, email }] })." },
      asunto: { type: "string", description: "Asunto del correo (puede llevar las marcas)." },
      cuerpo: { type: "string", description: "Cuerpo del correo en texto plano (puede llevar las marcas {nombre}, {nombre_completo}, {empresas})." },
      descripcion: { type: "string", description: "Una frase de qué es este envío (para el resumen y el registro). Opcional." },
      excluir: { type: "array", items: { type: "string" }, description: "Nombre y apellido de personas a dejar fuera. Opcional." },
      solo_listar: { type: "boolean", description: "true = solo decir a quién iría, sin preparar ningún envío." },
    },
    required: ["audiencia", "asunto", "cuerpo"],
  },
  handler: async (input, context) => {
    const peticion: PeticionEnvio = {
      audiencia: typeof input.audiencia === "string" ? input.audiencia.trim() : "",
      parametros: input.parametros && typeof input.parametros === "object" && !Array.isArray(input.parametros) ? input.parametros as Record<string, unknown> : {},
      asunto: typeof input.asunto === "string" ? input.asunto : "",
      cuerpo: typeof input.cuerpo === "string" ? input.cuerpo : "",
      descripcion: typeof input.descripcion === "string" ? input.descripcion : undefined,
      excluir: Array.isArray(input.excluir) ? input.excluir.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [],
    };
    try {
      if (input.solo_listar === true) return await listarPeticion(peticion);
      const chatId = context?.chatId;
      if (!chatId) return "Error: no se pudo determinar el chat de Telegram donde mostrar el envío.";
      return await prepararEnvioMasivo(chatId, peticion);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
