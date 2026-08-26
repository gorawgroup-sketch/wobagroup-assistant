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
 *
 * Limitación conocida (confirmada en vivo): al contar apariciones de
 * substring sin normalizar por longitud del documento (sin IDF), un
 * documento pequeño y muy específico puede perder contra documentos
 * grandes y genéricos que simplemente repiten más veces las mismas
 * palabras clave, aunque el documento pequeño sea el realmente relevante.
 * Por eso este mecanismo solo se usa cuando el corpus ya no cabe entero
 * (ver seleccionarDocumentosRelevantes) — con poco volumen es preferible
 * cargarlo todo y evitar el riesgo.
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

/**
 * Tamaño (caracteres) por debajo del cual se prefiere cargar TODO el corpus
 * de /docs en vez de aplicar scoring selectivo — a este volumen, cargar todo
 * cabe cómodamente en el contexto y evita el riesgo de scoring descrito
 * arriba. Por encima del umbral, cargar todo dejaría de ser barato y se usa
 * buscarDocumentosRelevantes (que sí puede perder documentos pequeños, pero
 * a cambio no desperdicia contexto en cada consulta).
 */
const UMBRAL_CARGA_COMPLETA = 40_000;

/**
 * Punto de entrada real para el tool consultar_base_conocimiento: decide
 * entre cargar todos los documentos regulares de /docs (corpus pequeño) o
 * aplicar el scoring por palabras clave de buscarDocumentosRelevantes
 * (corpus grande) — nunca ambos a la vez. No aplica a capturas/correcciones,
 * que se incluyen siempre desde sus propios stores en Sheets,
 * independientemente de este umbral.
 */
export function seleccionarDocumentosRelevantes(consulta: string): DocEntry[] {
  const docs = leerTodosLosDocs();
  const tamanoTotal = docs.reduce((acc, doc) => acc + doc.contenido.length, 0);

  if (tamanoTotal < UMBRAL_CARGA_COMPLETA) {
    return docs;
  }

  return buscarDocumentosRelevantes(consulta);
}

export interface ModoRetrieval {
  modo: "carga_completa" | "scoring";
  tamanoTotalCaracteres: number;
  umbralCaracteres: number;
  documentos: number;
}

/** Diagnóstico de qué modo está usando seleccionarDocumentosRelevantes ahora mismo, y por qué. */
export function obtenerModoRetrieval(): ModoRetrieval {
  const docs = leerTodosLosDocs();
  const tamanoTotal = docs.reduce((acc, doc) => acc + doc.contenido.length, 0);

  return {
    modo: tamanoTotal < UMBRAL_CARGA_COMPLETA ? "carga_completa" : "scoring",
    tamanoTotalCaracteres: tamanoTotal,
    umbralCaracteres: UMBRAL_CARGA_COMPLETA,
    documentos: docs.length,
  };
}
