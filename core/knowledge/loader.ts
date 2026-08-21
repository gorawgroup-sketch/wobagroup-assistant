import { readFileSync } from "node:fs";
import { join } from "node:path";

const RESPONSABILIDADES_PATH = join(__dirname, "..", "..", "docs", "responsabilidades.md");

let cachedKnowledge: string | null = null;

/**
 * Carga el contenido de /docs/responsabilidades.md para usarlo como contexto del sistema.
 * Se cachea en memoria tras la primera lectura.
 */
export function loadKnowledgeBase(): string {
  if (cachedKnowledge !== null) {
    return cachedKnowledge;
  }

  try {
    cachedKnowledge = readFileSync(RESPONSABILIDADES_PATH, "utf-8");
  } catch {
    cachedKnowledge = "";
  }

  return cachedKnowledge;
}
