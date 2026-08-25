import { unlink } from "node:fs/promises";
import { resolverCarpetaDestino, subirArchivoADrive } from "../drive/client";
import { ROOT_FOLDERS, type EmpresaConCarpeta } from "../drive/rootFolders";
import type { PropuestaClasificacion } from "./classificationStore";

export interface ResultadoArchivado {
  ok: boolean;
  mensaje: string;
  webViewLink?: string;
}

/**
 * Convierte "BAE / Colaboradores / Alejandra" en ["Alejandra", "Colaboradores", "BAE"]
 * — se prueba primero el segmento más específico (el último).
 */
function extraerCandidatosCarpeta(carpetaSugerida: string): string[] {
  return carpetaSugerida
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
}

/**
 * Sube a Drive el archivo local de una propuesta ya aprobada, y solo si la
 * subida fue exitosa borra la copia temporal. Único punto del código que
 * sube archivos a Drive — se invoca exclusivamente desde el callback del
 * botón "✅ Sí, archivar aquí" (ver documentCallbackHandler.ts), nunca
 * automáticamente.
 */
export async function archivarDocumentoEnDrive(propuesta: PropuestaClasificacion): Promise<ResultadoArchivado> {
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
    const candidatos = extraerCandidatosCarpeta(propuesta.clasificacion.carpetaSugerida);
    const destino = await resolverCarpetaDestino(rootFolderId, candidatos);

    const subida = await subirArchivoADrive(
      propuesta.rutaLocal,
      propuesta.nombreArchivoOriginal,
      propuesta.mimeType,
      destino.folderId
    );

    await unlink(propuesta.rutaLocal);

    const notaCarpeta = destino.encontrada
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
