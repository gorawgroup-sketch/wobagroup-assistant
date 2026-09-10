import { unlink } from "node:fs/promises";
import { resolverCarpetaDestino, resolverOCrearCarpeta, subirArchivoADrive } from "../drive/client";
import { ROOT_FOLDERS, type EmpresaConCarpeta } from "../drive/rootFolders";
import { reDescargarAdjuntoSiFalta } from "../gmail/reDescargarAdjunto";
import type { PropuestaClasificacion } from "./classificationStore";
import { esArchivoLocalInexistente } from "../drive/durableUpload";

export interface ResultadoArchivado {
  ok: boolean;
  mensaje: string;
  webViewLink?: string;
}

/** Convierte "BAE / Colaboradores / Alejandra" en ["BAE", "Colaboradores", "Alejandra"] — orden padre→hijo, tal como se escribió. */
function extraerRutaCarpeta(carpetaSugerida: string): string[] {
  return carpetaSugerida
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** La misma ruta pero invertida — se prueba primero el segmento más específico (el último), para la búsqueda de resolverCarpetaDestino (nunca crea, solo busca en todo el árbol). */
function extraerCandidatosCarpeta(carpetaSugerida: string): string[] {
  return extraerRutaCarpeta(carpetaSugerida).reverse();
}

/**
 * Sube a Drive el archivo local de una propuesta ya aprobada, y solo si la
 * subida fue exitosa borra la copia temporal. Único punto del código que
 * sube archivos a Drive — se invoca exclusivamente desde el callback del
 * botón "✅ Sí, archivar aquí" (ver documentCallbackHandler.ts), nunca
 * automáticamente.
 *
 * `crearCarpetaSiNoExiste`: caso real reportado por Carlos — al corregir la clasificación de un
 * documento, si la carpeta que pidió no existe, el sistema archivaba en la raíz en silencio en vez de
 * ofrecer crearla. Con este flag en true (solo cuando el usuario lo pidió explícitamente, ver
 * reclasificarDocumentoPendiente.ts), la ruta completa se CREA en vez de solo buscarse — nunca se usa
 * en el flujo normal de "✅ Sí, archivar aquí", que nunca debe crear carpetas sin que el usuario lo
 * pida directamente.
 */
export async function archivarDocumentoEnDrive(
  propuesta: PropuestaClasificacion,
  crearCarpetaSiNoExiste: boolean = false
): Promise<ResultadoArchivado> {
  const empresa = propuesta.clasificacion.empresa as EmpresaConCarpeta;
  const rootFolderId = ROOT_FOLDERS[empresa];

  if (!rootFolderId) {
    return {
      ok: false,
      mensaje:
        `No tengo configurada una carpeta de Drive para "${propuesta.clasificacion.empresa}". ` +
        `El archivo sigue guardado localmente, no se perdió — dime a qué empresa/carpeta pertenece.`,
    };
  }

  try {
    const destino = crearCarpetaSiNoExiste
      ? await resolverOCrearCarpeta(rootFolderId, extraerRutaCarpeta(propuesta.clasificacion.carpetaSugerida))
      : { ...(await resolverCarpetaDestino(rootFolderId, extraerCandidatosCarpeta(propuesta.clasificacion.carpetaSugerida))), creada: false };

    // Pedido explícito de Carlos, mismo caso real que motivó el reintento
    // equivalente en gastoCallbackHandler.ts: la copia local del adjunto no
    // sobrevive un redeploy de Railway, pero la propuesta en Sheets sí — un
    // documento que queda pendiente durante un redeploy pierde su copia de
    // trabajo aunque el original siga intacto en Gmail. Si la subida falla
    // y se sabe de qué mensaje/adjunto vino, se reintenta una vez tras
    // volver a descargarlo de la fuente durable.
    const idempotencyKey = `documento:${propuesta.id}`;
    const proceso = crearCarpetaSiNoExiste ? "documento_reclasificado" : "documento_aprobado";
    let subida: Awaited<ReturnType<typeof subirArchivoADrive>>;
    try {
      subida = await subirArchivoADrive(
        propuesta.rutaLocal,
        propuesta.nombreArchivoOriginal,
        propuesta.mimeType,
        destino.folderId,
        idempotencyKey,
        proceso
      );
    } catch (error) {
      // Un timeout/5xx de Drive podría significar que el archivo ya quedó
      // creado. Solo ENOENT autoriza recuperar la copia local y reintentar.
      if (!esArchivoLocalInexistente(error)) throw error;
      const recuperado = await reDescargarAdjuntoSiFalta(propuesta.rutaLocal, {
        mensajeIdGmail: propuesta.correoOrigen?.mensajeIdGmail,
        attachmentIdGmail: propuesta.correoOrigen?.attachmentIdGmail,
      });
      if (!recuperado) throw error;
      subida = await subirArchivoADrive(
        propuesta.rutaLocal,
        propuesta.nombreArchivoOriginal,
        propuesta.mimeType,
        destino.folderId,
        idempotencyKey,
        proceso
      );
    }

    // La subida puede haberse recuperado desde el ledger después de un
    // redeploy, cuando la copia temporal ya no existe. Una limpieza local
    // fallida nunca convierte un archivo verificado en un falso fallo.
    await unlink(propuesta.rutaLocal).catch((error) => {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") {
        console.error("[archiveFile] No se pudo limpiar la copia temporal después de verificar Drive:",
          error instanceof Error ? error.name : "Error");
      }
    });

    const notaCarpeta = destino.creada
      ? `la carpeta nueva "${destino.rutaEncontrada}" (recién creada)`
      : destino.encontrada
        ? `la carpeta "${destino.rutaEncontrada}"`
        : `la carpeta raíz de ${empresa} (no encontré una subcarpeta exacta para "${propuesta.clasificacion.carpetaSugerida}")`;

    return {
      ok: true,
      mensaje: `Subido a ${notaCarpeta}.`,
      webViewLink: subida.webViewLink,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      mensaje: `Error subiendo el archivo a Drive: ${message}. La copia local NO se borró.`,
    };
  }
}
