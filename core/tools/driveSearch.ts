import { searchDriveFiles } from "../drive/client";
import { ROOT_FOLDERS, type EmpresaConCarpeta } from "../drive/rootFolders";
import type { ToolDefinition } from "./types";

/**
 * Busca documentos por nombre en la carpeta raíz de Drive de la empresa
 * solicitada (recursivo, incluyendo subcarpetas). Solo lectura: no sube,
 * modifica ni lee el contenido de los archivos, solo indica dónde están.
 */
export const driveSearchTool: ToolDefinition = {
  name: "buscar_documento_drive",
  seguraParaModoRapido: true,
  description:
    "Busca archivos O carpetas por nombre en Google Drive dentro de la carpeta raíz de una empresa " +
    "del grupo (WOBA, EWORKS o Footprint), incluyendo subcarpetas. Devuelve SOLO dónde está cada " +
    "resultado y un link para abrirlo, NUNCA su contenido. Úsala solo cuando el usuario pregunte " +
    "dónde encontrar un documento o una carpeta (ej. 'la carpeta de normatividad España'). Si en " +
    "cambio la pregunta es sobre información/datos que podrían estar DENTRO de un documento (ej. un " +
    "NIF, una condición, una fecha, un monto — cualquier pregunta de contenido, no de ubicación), NO " +
    "te quedes solo con el nombre/link que esta tool te da — usa leer_documento_drive en su lugar (o " +
    "después de esta), que sí lee el contenido real. Para explorar qué hay dentro de una carpeta sin " +
    "saber el nombre exacto, usa en cambio listar_carpetas_drive.",
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
        description: "Término de búsqueda por nombre de archivo (coincidencia parcial).",
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
      return `No se encontraron archivos que coincidan con "${consulta}" en la carpeta de ${empresa}.`;
    }

    return resultados
      .map((r) => `${r.name} — ${r.folderPath} — ${r.friendlyType} — ${r.webViewLink}`)
      .join("\n");
  },
};
