import { unlink } from "node:fs/promises";
import {
  consumirPendienteReclasificacionPorChat,
  consumirPendienteReclasificacionPorId,
  obtenerPendienteReclasificacionPorChat,
} from "../documental/pendienteReclasificacionStore";
import { archivarDocumentoEnDrive } from "../documental/archiveFile";
import { registrarDocumentoArchivadoDesdeCorreo } from "../documental/documentoArchivadoPorCorreoStore";
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
    "en Colaboradores/Alejandra', 'es de Footprint', 'en la carpeta de Facturas'). Si el usuario no está " +
    "seguro de qué carpetas existen, usa PRIMERO listar_carpetas_drive para mostrárselas — no adivines " +
    "un nombre de carpeta que no verificaste. Nunca vuelvas a pedir que reenvíen el archivo — ya está " +
    "guardado localmente, solo falta saber dónde archivarlo.",
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
      crearCarpetaSiNoExiste: {
        type: "boolean",
        description:
          "true SOLO si el usuario pidió explícitamente crear una carpeta nueva (ej. 'créala', 'no existe, " +
          "hazla tú') — crea de verdad cada carpeta de la ruta que no exista todavía en Drive. Si el " +
          "usuario solo te dio un nombre de carpeta sin decir que la crees, deja esto en false — usa " +
          "listar_carpetas_drive primero para ver si ya existe con otro nombre parecido antes de asumir " +
          "que hace falta crearla.",
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
    const crearCarpetaSiNoExiste = input.crearCarpetaSiNoExiste === true;
    if (!empresa || !(EMPRESAS as readonly string[]).includes(empresa) || !carpeta) {
      return "Error: hace falta una empresa válida (WOBA, EWORKS o Footprint) y una carpeta — pregúntale al usuario cuál falta.";
    }

    const pendiente = await obtenerPendienteReclasificacionPorChat(chatId);
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
      resultado = await archivarDocumentoEnDrive(propuestaCorregida, crearCarpetaSiNoExiste);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error archivando el documento: ${message}. La pregunta sigue pendiente, se puede reintentar.`;
    }

    if (!resultado.ok) {
      return `No se pudo archivar "${pendiente.nombreArchivoOriginal}": ${resultado.mensaje} La pregunta sigue pendiente, se puede reintentar con otro dato.`;
    }

    await consumirPendienteReclasificacionPorId(pendiente.id, chatId).catch(() => undefined);

    // Ya se archivó de verdad (resultado.ok) — registra la resolución para que un reproceso futuro
    // del mismo correo no vuelva a descargar este adjunto (ver documentoArchivadoPorCorreoStore.ts;
    // mismo criterio que documentCallbackHandler.ts, solo en el punto real de éxito, nunca al proponer).
    if (pendiente.correoOrigen?.mensajeIdGmail && pendiente.correoOrigen?.attachmentIdGmail) {
      await registrarDocumentoArchivadoDesdeCorreo({
        mensajeIdGmail: pendiente.correoOrigen.mensajeIdGmail,
        attachmentId: pendiente.correoOrigen.attachmentIdGmail,
      }).catch((error) => console.error("[reclasificarDocumentoPendiente] Error registrando adjunto archivado (no crítico):", error));
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

/**
 * Hallazgo real de auditoría: el flujo de "Elegir otra carpeta" solo tenía la tool de arriba
 * (archivar), ninguna forma de decir "no lo archives, descártalo" una vez que la propuesta original
 * ya se reemplazó por este pendiente — si el usuario respondía "descártalo" en texto libre, el
 * modelo no tenía ninguna herramienta real para cumplirlo. Mismo comportamiento que el botón "❌
 * Descartar, no archivar" de la propuesta original (documentCallbackHandler.ts, doc_descartar): no
 * sube nada a Drive, no guarda nada, borra la copia local.
 */
export const descartarDocumentoPendienteTool: ToolDefinition = {
  name: "descartar_documento_pendiente",
  description:
    "Descarta (sin archivar en Drive ni guardar nada) un documento que quedó pendiente de reclasificar " +
    "tras 'Elegir otra carpeta' — úsala cuando el usuario responda en texto libre que NO hace falta " +
    "archivarlo (ej. 'descártalo', 'no es nada, ignóralo', 'era solo la firma del correo'). No pidas " +
    "confirmación adicional, es una acción reversible en el sentido de que no borra nada real, solo la " +
    "copia local temporal del archivo.",
  input_schema: { type: "object", properties: {} },
  handler: async (_input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede descartar ningún documento pendiente.";
    }

    const pendiente = await consumirPendienteReclasificacionPorChat(chatId);
    if (!pendiente) {
      return "No hay ningún documento pendiente de reclasificar para este chat (puede que ya se haya procesado, o que haya expirado).";
    }

    await unlink(pendiente.rutaLocal).catch(() => {});

    // Descartar es una decisión final legítima — registra la resolución igual que un archivado
    // exitoso, para que un reproceso futuro del mismo correo no vuelva a descargar este adjunto.
    if (pendiente.correoOrigen?.mensajeIdGmail && pendiente.correoOrigen?.attachmentIdGmail) {
      await registrarDocumentoArchivadoDesdeCorreo({
        mensajeIdGmail: pendiente.correoOrigen.mensajeIdGmail,
        attachmentId: pendiente.correoOrigen.attachmentIdGmail,
      }).catch((error) => console.error("[reclasificarDocumentoPendiente] Error registrando adjunto descartado (no crítico):", error));
    }

    if (pendiente.correoOrigen?.deColaCorreo) {
      await avanzarColaCorreoSiActivo(chatId);
    }

    return `Descartado: "${pendiente.nombreArchivoOriginal}" — no se archivó ni se guardó nada. No hace falta que lo repitas, ya se le puede confirmar al usuario.`;
  },
};
