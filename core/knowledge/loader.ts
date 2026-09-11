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
 * Hallazgo real de auditoría (integración del Plan General de Contabilidad, 2026-09-11 — documentos de
 * 30KB a 435KB, contra un corpus previo donde el más grande apenas llegaba a 56KB): la limitación ya
 * documentada acá ("un documento pequeño y muy específico puede perder contra documentos grandes y
 * genéricos") pasó de riesgo teórico a bug real, verificado en vivo. La consulta "cuenta contable
 * servicios profesionales independientes" nunca traía el cuadro de cuentas (la respuesta real),
 * porque palabras genéricas del propio dominio ("cuenta", "contable" — aparecen miles de veces en
 * CUALQUIER parte del Plan General de Contabilidad, sin distinguir nada entre sus partes) dominaban
 * el conteo bruto, ahogando a las palabras realmente distintivas de la consulta ("profesionales",
 * "independientes"). Dos correcciones probadas en vivo, ambas necesarias:
 * 1) IDF con corte duro — una palabra presente en más de la mitad de los documentos del corpus se
 *    considera genérica del dominio y pesa CERO (no "casi cero", un IDF suave del tipo
 *    1/documentos-que-la-contienen no bastaba: con miles de apariciones en un documento grande, hasta
 *    un peso pequeño seguía ganando por volumen); el resto pesa 1/documentos-que-la-contienen (más
 *    rara = más peso).
 * 2) Normalización logarítmica por longitud — SIN esto, una palabra de frecuencia media (ej. "nuevo",
 *    presente en la mitad exacta de los documentos, justo debajo del corte del punto 1) seguía
 *    ganando por volumen bruto en un documento de 230KB frente a un documento de 2KB genuinamente
 *    relevante. Dividir por la longitud DIRECTA (densidad por cada 1.000 caracteres) sobrecorrige en
 *    la otra dirección — deja ganar a un documento chico e IRRELEVANTE con una sola coincidencia de
 *    una palabra rara, verificado en vivo. Dividir por log(longitud) amortigua la ventaja de un
 *    documento enorme sin inflar documentos chicos por casualidad — verificado en vivo contra 5
 *    consultas reales (con y sin relación al Plan General de Contabilidad) sin regresión.
 */
export function buscarDocumentosRelevantes(consulta: string): DocEntry[] {
  const docs = leerTodosLosDocs();

  const palabras = normalizar(consulta)
    .split(/[^a-z0-9]+/i)
    .filter((p) => p.length >= LONGITUD_MINIMA_PALABRA);

  if (palabras.length === 0) return [];

  const contenidosNormalizados = docs.map((doc) => normalizar(doc.contenido));

  const pesoPorPalabra = new Map<string, number>();
  for (const palabra of palabras) {
    const docsConPalabra = contenidosNormalizados.filter((c) => c.includes(palabra)).length;
    const genericaDelDominio = docs.length > 0 && docsConPalabra / docs.length > 0.5;
    pesoPorPalabra.set(palabra, genericaDelDominio || docsConPalabra === 0 ? 0 : 1 / docsConPalabra);
  }

  const puntuados = docs.map((doc, i) => {
    const contenidoNormalizado = contenidosNormalizados[i];
    let coincidencias = 0;
    let puntaje = 0;
    for (const palabra of palabras) {
      const apariciones = contenidoNormalizado.split(palabra).length - 1;
      coincidencias += apariciones;
      puntaje += apariciones * (pesoPorPalabra.get(palabra) ?? 0);
    }
    // Normalizado por log(longitud), no por longitud directa — probado en vivo: dividir por longitud
    // directa (densidad por cada 1.000 caracteres) sobrecorrige y deja ganar a un documento chico e
    // IRRELEVANTE con una sola coincidencia de una palabra rara, contra un documento grande y sí
    // relevante con docenas de coincidencias reales. El logaritmo amortigua la ventaja de un documento
    // enorme sin inflar documentos chicos por casualidad.
    const puntajeNormalizado = puntaje / Math.log(contenidoNormalizado.length + 10);
    return { doc, coincidencias, puntajeNormalizado };
  });

  return puntuados
    .filter((p) => p.coincidencias > 0)
    .sort((a, b) => b.puntajeNormalizado - a.puntajeNormalizado)
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
