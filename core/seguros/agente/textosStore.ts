/**
 * Caché persistente del TEXTO de los documentos de pólizas que el especialista ya leyó.
 *
 * Por qué existe (medido en vivo el 05/10/2026): leer un PDF largo con visión cuesta ~0,15 $ y casi un minuto, y una
 * sola pregunta de condiciones («¿cubre daños a pantallas alquiladas?») leyó tres: ~0,65 $ y 4 minutos. Un documento
 * de una póliza no cambia entre preguntas, así que se lee UNA vez y su texto queda aquí; la clave es el contenido
 * (hash de los bytes), de modo que si Acodrid sustituye el archivo por otro, se vuelve a leer solo.
 *
 * Pestaña `_seguros_textos`; el texto se trocea (límite de 50.000 caracteres por celda de Sheets).
 */
import { createHash } from "node:crypto";
import { leerFilas, agregarFila, eliminarFilas } from "../../google/sheetsKeyValueStore";

const TAB_NAME = "_seguros_textos";
const HEADERS = ["docId", "version", "parte", "partes", "nombre", "texto"];
const NUM_COLS = HEADERS.length;
export const TAMANO_TROZO = 40_000;

export interface AlmacenTextos {
  /** El texto completo si hay una copia de ESA versión del documento; null si no. */
  buscar(docId: string, version: string): Promise<string | null>;
  guardar(docId: string, version: string, nombre: string, texto: string): Promise<void>;
}

export const versionDeBytes = (bytes: Buffer): string => createHash("sha1").update(bytes).digest("hex").slice(0, 16);

export function trocear(texto: string, tamano = TAMANO_TROZO): string[] {
  const trozos: string[] = [];
  for (let i = 0; i < texto.length; i += tamano) trozos.push(texto.slice(i, i + tamano));
  return trozos.length > 0 ? trozos : [""];
}

/** Reúne los trozos de un documento y devuelve su texto solo si están TODOS (una copia a medias no sirve). */
export function reunir(filas: Array<{ parte: number; partes: number; texto: string }>): string | null {
  if (filas.length === 0) return null;
  const partes = filas[0].partes;
  const porParte = new Map(filas.map((f) => [f.parte, f.texto]));
  if (!Number.isInteger(partes) || partes < 1 || porParte.size < partes) return null;
  const orden: string[] = [];
  for (let i = 1; i <= partes; i++) {
    const trozo = porParte.get(i);
    if (trozo === undefined) return null;
    orden.push(trozo);
  }
  return orden.join("");
}

export const almacenTextosReal: AlmacenTextos = {
  async buscar(docId, version) {
    const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
    return reunir(
      filas
        .filter((f) => f.valores[0] === docId && f.valores[1] === version)
        .map((f) => ({ parte: Number(f.valores[2]), partes: Number(f.valores[3]), texto: f.valores[5] ?? "" }))
    );
  },
  async guardar(docId, version, nombre, texto) {
    // Las versiones anteriores del mismo documento ya no sirven: se retiran antes de escribir la nueva.
    const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
    const viejas = filas.filter((f) => f.valores[0] === docId && f.valores[1] !== version).map((f) => f.rowIndex);
    if (viejas.length > 0) await eliminarFilas(TAB_NAME, viejas, HEADERS);
    const trozos = trocear(texto);
    for (let i = 0; i < trozos.length; i++) await agregarFila(TAB_NAME, NUM_COLS, HEADERS, [docId, version, i + 1, trozos.length, nombre, trozos[i]]);
  },
};

// ---------------------------------------------------------------------------------------------------------------

export interface LectorDocumentos {
  descargar(docId: string): Promise<{ bytes: Buffer; mimeType: string; name: string }>;
  /** Texto sin IA (Word, Excel, texto…); undefined si el formato necesita visión. */
  deterministico(bytes: Buffer, mimeType: string, nombre: string): Promise<string | undefined>;
  esVisual(mimeType: string): boolean;
  /** Lectura con visión (cara): PDF e imágenes. */
  transcribir(bytes: Buffer, mimeType: string, nombre: string, contexto: string): Promise<string>;
}

export interface TextoDocumento {
  texto: string;
  desdeCache: boolean;
}

/**
 * Texto de un documento de Drive: de la caché si ya se leyó esa versión; si no, se lee (primero sin IA, con visión solo si
 * hace falta) y se guarda. Un fallo al guardar no impide devolver el texto leído.
 */
export async function textoDeDocumento(
  doc: { id: string; name: string; folderPath: string },
  contexto: string,
  lector: LectorDocumentos,
  almacen: AlmacenTextos
): Promise<TextoDocumento> {
  const archivo = await lector.descargar(doc.id);
  const version = versionDeBytes(archivo.bytes);
  const guardado = await almacen.buscar(doc.id, version).catch((error) => {
    console.error("[agenteSeguros] No se pudo consultar la caché de textos (se lee el documento):", error instanceof Error ? error.message : error);
    return null;
  });
  if (guardado !== null) return { texto: guardado, desdeCache: true };

  let texto = await lector.deterministico(archivo.bytes, archivo.mimeType, archivo.name);
  if (texto === undefined) {
    if (!lector.esVisual(archivo.mimeType)) throw new Error(`El formato ${archivo.mimeType || "desconocido"} no expone texto verificable con los lectores disponibles.`);
    texto = await lector.transcribir(archivo.bytes, archivo.mimeType, archivo.name, contexto);
  }
  await almacen.guardar(doc.id, version, archivo.name || doc.name, texto).catch((error) =>
    console.error("[agenteSeguros] No se pudo guardar el texto en la caché (no crítico):", error instanceof Error ? error.message : error)
  );
  return { texto, desdeCache: false };
}
