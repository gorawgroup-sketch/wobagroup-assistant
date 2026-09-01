import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { searchDriveFiles, descargarArchivoDrive } from "../drive/client";
import { ROOT_FOLDERS, type EmpresaConCarpeta } from "../drive/rootFolders";
import { transcribirParaCaptura } from "../documental/transcribeForCapture";
import type { ToolDefinition } from "./types";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
}

/**
 * Pedido explícito de Carlos, tras un caso real: un documento ya archivado
 * en Drive ("guía rápida de control de accesos") existía y era exactamente
 * lo que preguntaba, pero buscar_documento_drive solo dice DÓNDE está un
 * archivo (nombre + link), nunca su contenido — así que Wobi no podía
 * responder la pregunta real con esa info, solo señalar que el archivo
 * existe. Esta tool cierra ese hueco: busca, y si hay un único resultado
 * claro (o si el usuario ya dio el nombre exacto), lo descarga y lee su
 * contenido real con Claude vision (mismo mecanismo que transcribirParaCaptura,
 * ya usado para CAPTURA) — para que Wobi pueda responder con la información
 * real, no solo con un link para que el usuario mismo lo abra.
 *
 * Si hay varios resultados posibles, nunca elige sola — los lista para que
 * el usuario confirme cuál, mismo principio que el resto del proyecto
 * (nunca asumir sin evidencia clara). Solo lee PDF/imagen (lo que Claude
 * vision soporta) — un Google Doc/Sheet nativo no está soportado todavía.
 */
export const leerDocumentoDriveTool: ToolDefinition = {
  name: "leer_documento_drive",
  seguraParaModoRapido: true,
  description:
    "Busca un documento en Drive por nombre/tema Y LEE SU CONTENIDO REAL (no solo dónde está) — úsala " +
    "cuando alguien pregunte algo cuya respuesta podría estar en un documento ya archivado (ej. 'guía de " +
    "control de accesos', 'política de vacaciones', 'contrato de X'), especialmente si " +
    "consultar_base_conocimiento no encontró nada: antes de decir 'no tengo información', prueba esta " +
    "tool con palabras clave del tema (y si no sabes la empresa, prueba con las 3) — un documento puede " +
    "estar archivado en Drive sin haber sido transcrito nunca a la base de conocimiento. Solo lee PDF o " +
    "imágenes (no Google Docs/Sheets nativos todavía). Si encuentra VARIOS resultados posibles, no elige " +
    "sola — te los lista para que el usuario confirme cuál, y ahí puedes volver a llamarla pasando el " +
    "nombre exacto en 'consulta' para leer ese en concreto.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint"],
        description: "Empresa del grupo cuya carpeta raíz de Drive se consulta.",
      },
      consulta: {
        type: "string",
        description: "Término de búsqueda por nombre de archivo, o el nombre exacto si ya se conoce.",
      },
    },
    required: ["empresa", "consulta"],
  },
  handler: async (input) => {
    const empresa = input.empresa as EmpresaConCarpeta;
    if (!ROOT_FOLDERS[empresa]) {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const consulta = typeof input.consulta === "string" ? input.consulta.trim() : "";
    if (!consulta) {
      return "Error: falta el término de búsqueda ('consulta').";
    }

    const rootFolderId = ROOT_FOLDERS[empresa];
    const resultados = await searchDriveFiles(rootFolderId, consulta);

    if (resultados.length === 0) {
      return `No encontré ningún archivo que coincida con "${consulta}" en la carpeta de ${empresa}.`;
    }

    if (resultados.length > 1) {
      const lista = resultados.map((r) => `- ${r.name} — ${r.folderPath}`).join("\n");
      return (
        `Encontré ${resultados.length} archivos que podrían coincidir con "${consulta}" en ${empresa}, ` +
        `no voy a elegir solo — pregúntale al usuario cuál es, y vuelve a llamar esta tool con el nombre ` +
        `exacto en 'consulta':\n${lista}`
      );
    }

    const resultado = resultados[0];
    const mimesLegibles = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!resultado.mimeType || !mimesLegibles.includes(resultado.mimeType)) {
      return (
        `Encontré "${resultado.name}" (${resultado.folderPath}) pero es de un tipo que no puedo leer ` +
        `todavía (${resultado.mimeType ?? "desconocido"} — solo PDF/imagen por ahora). Link: ${resultado.webViewLink}`
      );
    }

    let rutaLocal: string | undefined;
    try {
      const archivo = await descargarArchivoDrive(resultado.id);
      await mkdir(UPLOADS_DIR, { recursive: true });
      rutaLocal = join(UPLOADS_DIR, `${Date.now()}_${sanitizarNombre(archivo.name)}`);
      await writeFile(rutaLocal, archivo.bytes);

      const texto = await transcribirParaCaptura(
        rutaLocal,
        archivo.mimeType,
        `Documento archivado en Drive (${empresa}, ${resultado.folderPath}), leído porque el usuario preguntó sobre "${consulta}".`
      );

      return `📄 Contenido de "${resultado.name}" (${resultado.folderPath}, ${resultado.webViewLink}):\n\n${texto}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Encontré "${resultado.name}" pero hubo un error leyendo su contenido: ${message}. Link para abrirlo a mano: ${resultado.webViewLink}`;
    } finally {
      if (rutaLocal) await unlink(rutaLocal).catch(() => {});
    }
  },
};
