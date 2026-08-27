import { listarCarpetasEnRuta } from "../drive/client";
import { ROOT_FOLDERS, type EmpresaConCarpeta } from "../drive/rootFolders";
import type { ToolDefinition } from "./types";

/**
 * Lista subcarpetas de Drive (nunca archivos) dentro de una ruta dada, para
 * explorar la estructura real de carpetas de una empresa sin adivinar
 * nombres. Complementa a buscar_documento_drive, que solo encuentra
 * archivos por nombre y no sirve para preguntas de tipo "¿qué hay dentro de
 * X?" o "¿hasta qué trimestre existe Y?".
 */
export const driveListFoldersTool: ToolDefinition = {
  name: "listar_carpetas_drive",
  seguraParaModoRapido: true,
  description:
    "Lista los nombres de las subcarpetas dentro de una ruta de Drive de una empresa del grupo " +
    "(WOBA, EWORKS o Footprint). Úsala para explorar la estructura de carpetas cuando la pregunta " +
    "requiere ver qué existe (ej. 'hasta qué trimestre hay backups', 'qué carpetas hay dentro de X') " +
    "en vez de buscar un archivo puntual por nombre (para eso usa buscar_documento_drive). Empieza " +
    "con 'ruta' vacía para ver las carpetas de primer nivel, y ve descendiendo pasando en 'ruta' los " +
    "nombres (exactos o parciales) que te devolvió la llamada anterior, en orden.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint"],
        description: "Empresa del grupo cuya carpeta raíz de Drive se explora.",
      },
      ruta: {
        type: "array",
        items: { type: "string" },
        description:
          "Ruta de nombres de carpetas a descender desde la raíz, en orden (ej. [\"BACK UP\", \"2026\"]). " +
          "Omite o deja vacío para listar las carpetas de primer nivel.",
      },
    },
    required: ["empresa"],
  },
  handler: async (input) => {
    const empresa = input.empresa as EmpresaConCarpeta;
    if (!ROOT_FOLDERS[empresa]) {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const ruta = Array.isArray(input.ruta) ? (input.ruta as unknown[]).map(String) : [];
    const carpetas = await listarCarpetasEnRuta(ROOT_FOLDERS[empresa], ruta);

    if (carpetas.length === 0) {
      return ruta.length > 0
        ? `No se encontraron subcarpetas en ${empresa} / ${ruta.join(" / ")} (o algún segmento de la ruta no existe).`
        : `No se encontraron carpetas de primer nivel en ${empresa}.`;
    }

    return carpetas.join(", ");
  },
};
