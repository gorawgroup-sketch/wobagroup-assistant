import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DOCS_DIR = join(process.cwd(), "docs");

export interface DocEntry {
  nombre: string;
  contenido: string;
}

export interface FragmentoDocumento extends DocEntry {
  seccion: string;
  puntaje: number;
}

let cachedDocs: DocEntry[] | null = null;
let cachedFragmentos: FragmentoDocumento[] | null = null;

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
  cachedFragmentos = null;
}

const DIACRITICOS = new RegExp("[̀-ͯ]", "g");

export function normalizarConocimiento(texto: string): string {
  return texto.normalize("NFD").replace(DIACRITICOS, "").toLowerCase();
}

const PALABRAS_VACIAS = new Set([
  "para", "como", "esta", "este", "esto", "estos", "estas", "desde", "hasta", "sobre", "entre",
  "donde", "cuando", "quien", "cual", "porque", "pero", "solo", "tambien", "tiene", "tener", "hacer",
  "hecho", "grupo", "empresa", "informacion", "documento", "consulta", "necesito", "quiero", "the", "and",
  "with", "from", "that", "this", "what", "when", "where",
]);

export function terminosConocimiento(consulta: string): string[] {
  return Array.from(
    new Set(
      normalizarConocimiento(consulta)
        .split(/[^a-z0-9]+/i)
        .filter((p) => p.length >= 3 && !PALABRAS_VACIAS.has(p))
    )
  );
}

/** Puntaje acotado y reutilizable para capturas/correcciones dinámicas. */
export function puntuarTextoConocimiento(texto: string, consulta: string): number {
  const normalizado = normalizarConocimiento(texto);
  const terminos = terminosConocimiento(consulta);
  if (terminos.length === 0) return 0;

  let puntaje = 0;
  let distintos = 0;
  for (const termino of terminos) {
    const apariciones = normalizado.split(termino).length - 1;
    if (apariciones > 0) {
      distintos += 1;
      puntaje += 3 + Math.min(apariciones, 8);
    }
  }

  const frase = normalizarConocimiento(consulta).trim();
  if (frase.length >= 8 && normalizado.includes(frase)) puntaje += 20;
  return puntaje + distintos * 2;
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

const MAX_FRAGMENTO_CARACTERES = 6_000;
const SOLAPAMIENTO_CARACTERES = 500;
const LONGITUD_MINIMA_CORTE = Math.floor(MAX_FRAGMENTO_CARACTERES * 0.6);

function cortarCercaDeSalto(texto: string, inicio: number, limite: number): number {
  if (limite >= texto.length) return texto.length;
  const minimo = inicio + LONGITUD_MINIMA_CORTE;
  const dobleSalto = texto.lastIndexOf("\n\n", limite);
  if (dobleSalto >= minimo) return dobleSalto + 2;
  const salto = texto.lastIndexOf("\n", limite);
  return salto >= minimo ? salto + 1 : limite;
}

function fragmentarDocumento(doc: DocEntry): FragmentoDocumento[] {
  const contenido = doc.contenido.replace(/\f/g, "\n");
  const resultado: FragmentoDocumento[] = [];
  let inicio = 0;
  let numero = 1;

  while (inicio < contenido.length) {
    const fin = cortarCercaDeSalto(contenido, inicio, inicio + MAX_FRAGMENTO_CARACTERES);
    const trozo = contenido.slice(inicio, fin).trim();
    if (trozo) {
      const encabezado = trozo
        .split("\n")
        .find((linea) => /^#{1,6}\s+/.test(linea.trim()))
        ?.replace(/^#{1,6}\s+/, "")
        .trim();
      resultado.push({
        nombre: doc.nombre,
        contenido: trozo,
        seccion: encabezado || `fragmento ${numero}`,
        puntaje: 0,
      });
      numero += 1;
    }
    if (fin >= contenido.length) break;
    inicio = Math.max(inicio + 1, fin - SOLAPAMIENTO_CARACTERES);
  }

  return resultado;
}

function leerFragmentos(): FragmentoDocumento[] {
  if (cachedFragmentos !== null) return cachedFragmentos;
  cachedFragmentos = leerTodosLosDocs().flatMap(fragmentarDocumento);
  return cachedFragmentos;
}

export interface OpcionesFragmentos {
  incluirPGC?: boolean;
  maxCaracteres?: number;
  maxFragmentos?: number;
}

/**
 * Recuperación por fragmentos con presupuesto estricto. El corpus original permanece completo en disco; nunca
 * se resume ni se elimina. Solo se limita lo que viaja en UNA llamada al modelo. Esto evita que un documento
 * grande (el PGC supera 400 KB) se reenvíe entero en cada vuelta de tool-use.
 */
export function buscarFragmentosRelevantes(
  consulta: string,
  opciones: OpcionesFragmentos = {}
): FragmentoDocumento[] {
  const incluirPGC = opciones.incluirPGC ?? true;
  const maxCaracteres = Math.max(1_000, opciones.maxCaracteres ?? 14_000);
  const maxFragmentos = Math.max(1, opciones.maxFragmentos ?? 5);
  const terminos = terminosConocimiento(consulta);
  if (terminos.length === 0) return [];

  const candidatos = leerFragmentos().filter(
    (fragmento) => incluirPGC || !fragmento.nombre.startsWith("PGC_")
  );
  const frecuenciaDocumental = new Map<string, number>();
  for (const termino of terminos) {
    frecuenciaDocumental.set(
      termino,
      candidatos.filter((fragmento) => normalizarConocimiento(fragmento.contenido).includes(termino)).length
    );
  }

  const puntuados = candidatos
    .map((fragmento) => {
      const texto = normalizarConocimiento(
        `${fragmento.nombre} ${fragmento.seccion}\n${fragmento.contenido}`
      );
      let puntaje = 0;
      let distintos = 0;
      for (const termino of terminos) {
        const apariciones = texto.split(termino).length - 1;
        if (apariciones <= 0) continue;
        distintos += 1;
        const frecuencia = frecuenciaDocumental.get(termino) ?? 1;
        const idf = Math.log((candidatos.length + 1) / (frecuencia + 1)) + 1;
        puntaje += (2 + Math.log1p(apariciones)) * idf;
      }
      const cobertura = distintos / terminos.length;
      puntaje += cobertura * 12;
      if (distintos === terminos.length) puntaje += 8;
      return { ...fragmento, puntaje };
    })
    .filter((fragmento) => fragmento.puntaje > 0)
    .sort((a, b) => b.puntaje - a.puntaje || a.nombre.localeCompare(b.nombre));

  const seleccionados: FragmentoDocumento[] = [];
  let usados = 0;
  for (const fragmento of puntuados) {
    if (seleccionados.length >= maxFragmentos) break;
    const cabecera = `<!-- Fuente: docs/${fragmento.nombre}; sección: ${fragmento.seccion} -->\n`;
    const disponible = maxCaracteres - usados - cabecera.length;
    if (disponible < 300) break;
    const contenido = fragmento.contenido.slice(0, disponible);
    seleccionados.push({ ...fragmento, contenido });
    usados += cabecera.length + contenido.length + 6;
  }

  return seleccionados;
}

/** Compatibilidad para consumidores previos; devuelve únicamente los fragmentos presupuestados. */
export function buscarDocumentosRelevantes(consulta: string): DocEntry[] {
  return buscarFragmentosRelevantes(consulta, { maxCaracteres: 18_000 }).map(
    ({ nombre, contenido }) => ({ nombre, contenido })
  );
}

/**
 * Compatibilidad con consumidores existentes. Las llamadas del modelo deben usar buscarFragmentosRelevantes;
 * esta función ya no devuelve documentos gigantes completos.
 */
export function seleccionarDocumentosRelevantes(consulta: string): DocEntry[] {
  return buscarFragmentosRelevantes(consulta).map(({ nombre, contenido }) => ({ nombre, contenido }));
}

export interface ModoRetrieval {
  modo: "carga_completa" | "scoring_fragmentos";
  tamanoTotalCaracteres: number;
  umbralCaracteres: number;
  documentos: number;
  fragmentos: number;
  maxCaracteresPorConsulta: number;
}

/** Diagnóstico del modo acotado para el panel de control. */
export function obtenerModoRetrieval(): ModoRetrieval {
  const docs = leerTodosLosDocs();
  const tamanoTotalCaracteres = docs.reduce((acc, doc) => acc + doc.contenido.length, 0);
  const umbralCaracteres = 40_000;

  return {
    modo: tamanoTotalCaracteres < umbralCaracteres ? "carga_completa" : "scoring_fragmentos",
    tamanoTotalCaracteres,
    umbralCaracteres,
    documentos: docs.length,
    fragmentos: leerFragmentos().length,
    maxCaracteresPorConsulta: 14_000,
  };
}
