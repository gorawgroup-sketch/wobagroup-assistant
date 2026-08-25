import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DOCS_DIR = join(process.cwd(), "docs");

interface DocEntry {
  nombre: string;
  contenido: string;
}

let cachedDocs: DocEntry[] | null = null;

function leerTodosLosDocs(): DocEntry[] {
  if (cachedDocs !== null) return cachedDocs;

  try {
    const archivosMd = readdirSync(DOCS_DIR)
      .filter((nombre) => nombre.toLowerCase().endsWith(".md"))
      .sort();

    cachedDocs = archivosMd.map((nombre) => ({
      nombre,
      contenido: readFileSync(join(DOCS_DIR, nombre), "utf-8"),
    }));
  } catch {
    cachedDocs = [];
  }

  return cachedDocs;
}

/** Fuerza a que la próxima consulta vuelva a leer disco (ej. tras guardar una captura nueva). */
export function invalidarCacheConocimiento(): void {
  cachedDocs = null;
}

const DIACRITICOS = new RegExp("[̀-ͯ]", "g");

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(DIACRITICOS, "").toLowerCase();
}

export interface IndiceDocumento {
  nombre: string;
  resumen: string;
}

/** Índice ligero (nombre + primera línea no vacía) para cuando ninguna búsqueda encuentra nada claro. */
export function obtenerIndiceDocumentos(): IndiceDocumento[] {
  return leerTodosLosDocs().map((doc) => ({
    nombre: doc.nombre,
    resumen: doc.contenido.split("\n").find((l) => l.trim().length > 0)?.trim().slice(0, 150) ?? "",
  }));
}

const MAX_DOCS_RELEVANTES = 3;
const LONGITUD_MINIMA_PALABRA = 3;

/**
 * Selecciona, por coincidencia simple de palabras clave (insensible a
 * mayúsculas/acentos), los documentos de /docs más relevantes a `consulta`
 * — en vez de cargar y concatenar todo el contenido de /docs en cada
 * llamada, que desperdicia contexto en preguntas puntuales y no escala
 * si se agregan más documentos.
 */
export function buscarDocumentosRelevantes(consulta: string): DocEntry[] {
  const docs = leerTodosLosDocs();

  const palabras = normalizar(consulta)
    .split(/[^a-z0-9]+/i)
    .filter((p) => p.length >= LONGITUD_MINIMA_PALABRA);

  if (palabras.length === 0) return [];

  const puntuados = docs.map((doc) => {
    const contenidoNormalizado = normalizar(doc.contenido);
    const score = palabras.reduce((acc, palabra) => acc + (contenidoNormalizado.split(palabra).length - 1), 0);
    return { doc, score };
  });

  return puntuados
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DOCS_RELEVANTES)
    .map((p) => p.doc);
}
