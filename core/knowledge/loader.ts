import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DOCS_DIR = join(process.cwd(), "docs");

let cachedKnowledge: string | null = null;

/**
 * Carga y combina TODOS los archivos .md dentro de /docs (no solo
 * responsabilidades.md) para usarlos como contexto del sistema. Cualquier
 * documento nuevo que se agregue a esa carpeta queda disponible
 * automáticamente, sin tocar código. Se cachea en memoria tras la primera
 * lectura, ordenado alfabéticamente para que el resultado sea determinista.
 */
export function loadKnowledgeBase(): string {
  if (cachedKnowledge !== null) {
    return cachedKnowledge;
  }

  try {
    const archivosMd = readdirSync(DOCS_DIR)
      .filter((nombre) => nombre.toLowerCase().endsWith(".md"))
      .sort();

    cachedKnowledge = archivosMd
      .map((nombre) => {
        const contenido = readFileSync(join(DOCS_DIR, nombre), "utf-8");
        return `<!-- Fuente: docs/${nombre} -->\n${contenido}`;
      })
      .join("\n\n---\n\n");
  } catch {
    cachedKnowledge = "";
  }

  return cachedKnowledge;
}
