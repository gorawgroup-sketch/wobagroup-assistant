import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { descargarArchivoDrive, searchDriveFiles } from "../drive/client";
import { ROOT_FOLDERS, type EmpresaConCarpeta } from "../drive/rootFolders";
import { integrarDocumentoPoliza } from "../seguros/integrarDocumentoPoliza";
import { elegirMejorCandidato } from "./leerDocumentoDrive";
import type { ToolDefinition } from "./types";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

/**
 * «Dile a Wobi Seguros que lea este documento» para algo que YA está en Drive (archivado antes de que existiera la
 * integración automática de archiveFile.ts, o subido a mano). Pedido de Carlos (2026-10-01): archivar no basta, el
 * agente de seguros tiene que conocer el documento. Solo lee Drive y añade conocimiento; no modifica el registro de
 * pólizas ni nada en Drive.
 */
export const integrarDocumentoSeguroTool: ToolDefinition = {
  name: "integrar_documento_seguro",
  description:
    "Hace que Wobi Seguros LEA un documento de póliza que ya está archivado en Drive (condiciones particulares, " +
    "suplemento, certificado…) y lo integre a su conocimiento, enlazado a su póliza del registro. Úsala cuando el " +
    "usuario pida que Wobi Seguros lea, conozca o integre un documento de seguros que ya está en Drive («dile a Wobi " +
    "Seguros que lea las condiciones de la RC», «que seguros tenga en cuenta el suplemento del showroom»). Los " +
    "documentos que se archivan desde un correo en la carpeta de seguros ya se integran solos: no hace falta llamarla " +
    "para esos. Después, consultar_polizas_seguro muestra el documento con su resumen y su enlace.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa en cuyo Drive está el documento." },
      consulta: { type: "string", description: "Nombre del archivo o palabras clave para encontrarlo (ej. '054239034 suplemento', 'condiciones particulares RC')." },
    },
    required: ["empresa", "consulta"],
  },
  handler: async (input) => {
    const empresa = input.empresa as EmpresaConCarpeta;
    if (!ROOT_FOLDERS[empresa]) return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    const consulta = typeof input.consulta === "string" ? input.consulta.trim() : "";
    if (!consulta) return "Error: falta 'consulta' (nombre o palabras clave del documento).";

    const resultados = await searchDriveFiles(ROOT_FOLDERS[empresa], consulta);
    if (resultados.length === 0) return `No encontré en el Drive de ${empresa} ningún documento que coincida con "${consulta}".`;
    const elegido = resultados.length === 1 ? resultados[0] : elegirMejorCandidato(resultados, consulta);
    if (!elegido) {
      return `Hay ${resultados.length} documentos que coinciden con "${consulta}" y ninguno destaca. Pregunta al usuario cuál es y ` +
        `vuelve a llamar con su nombre exacto:\n` + resultados.slice(0, 8).map((r) => `- ${r.name} (${r.folderPath})`).join("\n");
    }

    const archivo = await descargarArchivoDrive(elegido.id);
    await mkdir(UPLOADS_DIR, { recursive: true });
    const rutaLocal = join(UPLOADS_DIR, `${Date.now()}_${archivo.name.replace(/[^\w.\-]+/g, "_").slice(0, 150)}`);
    await writeFile(rutaLocal, archivo.bytes);
    try {
      const resultado = await integrarDocumentoPoliza({
        rutaLocal,
        mimeType: archivo.mimeType,
        nombreArchivo: elegido.name,
        enlaceDrive: elegido.webViewLink,
        origen: `Documento de Drive (${empresa}, ${elegido.folderPath}).`,
      });
      if (resultado.estado === "no_es_poliza") {
        return `Leí "${elegido.name}" (${elegido.folderPath}) y no es documentación de una póliza de seguro: no lo añadí al conocimiento de Wobi Seguros.`;
      }
      return `${resultado.mensaje} Documento: "${elegido.name}" (${elegido.folderPath}) ${elegido.webViewLink}` +
        (resultado.documento?.resumen ? `\nResumen guardado: ${resultado.documento.resumen}` : "");
    } finally {
      await unlink(rutaLocal).catch((error) => {
        console.error("[integrarDocumentoSeguro] No se pudo limpiar la copia temporal:", error instanceof Error ? error.name : "Error");
      });
    }
  },
};
