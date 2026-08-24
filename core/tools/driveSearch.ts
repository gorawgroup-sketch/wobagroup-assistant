import { searchDriveFiles } from "../drive/client";
import type { ToolDefinition } from "./types";

const ROOT_FOLDERS: Record<"WOBA" | "EWORKS", string> = {
  WOBA: "1BvNawKKN6BUxStcU8FqXRBLuKmkxa-Q8",
  EWORKS: "1CYMOAUnOJN1eTIlmvNaJVyZ1ujNLB-e8",
};

/**
 * Busca documentos por nombre en la carpeta raíz de Drive de la empresa
 * solicitada (recursivo, incluyendo subcarpetas). Solo lectura: no sube,
 * modifica ni lee el contenido de los archivos, solo indica dónde están.
 */
export const driveSearchTool: ToolDefinition = {
  name: "buscar_documento_drive",
  description:
    "Busca archivos por nombre en Google Drive dentro de la carpeta raíz de una empresa del grupo " +
    "(WOBA o EWORKS), incluyendo subcarpetas. Devuelve dónde está cada archivo y un link para " +
    "abrirlo, no su contenido. Úsala cuando el usuario pregunte dónde encontrar un documento, " +
    "contrato, factura escaneada u otro archivo por nombre.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
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
    const empresa = input.empresa as "WOBA" | "EWORKS";
    if (empresa !== "WOBA" && empresa !== "EWORKS") {
      return "Error: 'empresa' debe ser WOBA o EWORKS.";
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
