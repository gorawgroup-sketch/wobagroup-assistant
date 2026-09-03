import { consumirPendienteReclasificacionPorChat, guardarPendienteReclasificacion } from "../documental/pendienteReclasificacionStore";
import { archivarDocumentoEnDrive } from "../documental/archiveFile";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import type { PropuestaClasificacion } from "../documental/classificationStore";
import type { ToolDefinition } from "./types";

const EMPRESAS = ["WOBA", "EWORKS", "Footprint"] as const;

/**
 * Pedido explícito de Carlos, tras verificar el sistema y encontrar un bug
 * real: "✏️ Elegir otra carpeta" preguntaba la empresa/carpeta correctas por
 * texto libre, pero no había NINGÚN mecanismo que retomara ese archivado —
 * la propuesta original ya se había borrado al presionar el botón, así que
 * la respuesta de Carlos no tenía ningún efecto real (el botón, en la
 * práctica, no completaba nada). Esta tool cierra ese hueco, mismo patrón
 * que reintentar_gasto_pendiente / reintentar_contacto_pendiente.
 */
export const reclasificarDocumentoPendienteTool: ToolDefinition = {
  name: "reclasificar_documento_pendiente",
  description:
    "Archiva en Drive un documento que quedó pendiente porque el usuario pidió 'Elegir otra carpeta' — " +
    "úsala cuando el usuario responda en texto libre con la empresa y/o carpeta correctas (ej. 'EWORKS, " +
    "en Colaboradores/Alejandra', 'es de Footprint', 'en la carpeta de Facturas'). Nunca vuelvas a pedir " +
    "que reenvíen el archivo — ya está guardado localmente, solo falta saber dónde archivarlo.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: [...EMPRESAS],
        description: "La empresa correcta que el usuario acaba de confirmar.",
      },
      carpeta: {
        type: "string",
        description:
          "La carpeta/ruta correcta dentro de esa empresa, tal como la haya dicho el usuario (ej. " +
          "'Colaboradores/Alejandra', o solo 'Facturas'). Si no especificó ninguna carpeta en particular, " +
          "usa el tipo de documento original o algo genérico como 'Otros'.",
      },
    },
    required: ["empresa", "carpeta"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede reclasificar ningún documento pendiente.";
    }

    const empresa = typeof input.empresa === "string" ? input.empresa : undefined;
    const carpeta = typeof input.carpeta === "string" ? input.carpeta.trim() : "";
    if (!empresa || !(EMPRESAS as readonly string[]).includes(empresa) || !carpeta) {
      return "Error: hace falta una empresa válida (WOBA, EWORKS o Footprint) y una carpeta — pregúntale al usuario cuál falta.";
    }

    const pendiente = await consumirPendienteReclasificacionPorChat(chatId);
    if (!pendiente) {
      return "No hay ningún documento pendiente de reclasificar para este chat (puede que ya se haya procesado, o que haya expirado).";
    }

    const propuestaCorregida: PropuestaClasificacion = {
      id: pendiente.id,
      nombreArchivoOriginal: pendiente.nombreArchivoOriginal,
      rutaLocal: pendiente.rutaLocal,
      mimeType: pendiente.mimeType,
      clasificacion: {
        empresa: empresa as (typeof EMPRESAS)[number],
        tipoDocumento: pendiente.tipoDocumentoOriginal,
        carpetaSugerida: carpeta,
        confianza: "alta",
        razon: "Empresa/carpeta corregidas manualmente por el usuario.",
      },
      chatId,
      messageId: 0,
      creadoEn: pendiente.creadoEn,
      correoOrigen: pendiente.correoOrigen,
    };

    let resultado: Awaited<ReturnType<typeof archivarDocumentoEnDrive>>;
    try {
      resultado = await archivarDocumentoEnDrive(propuestaCorregida);
    } catch (error) {
      // Se reinserta el pendiente para no perderlo por un error transitorio.
      await guardarPendienteReclasificacion({ ...pendiente }).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      return `Error archivando el documento: ${message}. La pregunta sigue pendiente, se puede reintentar.`;
    }

    if (!resultado.ok) {
      // No se logró archivar (ej. no existe esa empresa/carpeta) — se
      // reinserta para poder reintentar con otro dato, igual que un error
      // transitorio. Nunca avanza la cola sobre un archivado que no ocurrió.
      await guardarPendienteReclasificacion({ ...pendiente }).catch((error) =>
        console.error("[reclasificarDocumentoPendiente] Error reinsertando el pendiente:", error)
      );
      return `No se pudo archivar "${pendiente.nombreArchivoOriginal}": ${resultado.mensaje} La pregunta sigue pendiente, se puede reintentar con otro dato.`;
    }

    if (pendiente.correoOrigen?.deColaCorreo) {
      await avanzarColaCorreoSiActivo(chatId);
    }

    return (
      `Archivado con éxito: "${pendiente.nombreArchivoOriginal}" (empresa ${empresa}, carpeta "${carpeta}"). ` +
      `${resultado.mensaje} Link de Drive: ${resultado.webViewLink ?? "(no disponible)"}. No hace falta que lo repitas, ya se le puede confirmar al usuario.`
    );
  },
};
