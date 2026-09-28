import { ROOT_FOLDERS } from "../drive/rootFolders";
import {
  searchDriveFilesAllRoots,
  type DriveSearchResultGlobal,
} from "../drive/client";
import {
  normalizarConocimiento,
  puntuarTextoConocimiento,
  terminosConocimiento,
} from "../knowledge/loader";
import { consultarBaseConocimiento } from "./knowledgeBase";
import { leerContenidoDrive } from "./leerDocumentoDrive";
import type { ToolDefinition } from "./types";

const MAX_FUENTES_DRIVE = 2;
const MAX_CARACTERES_FUENTE = 9_000;
const MAX_CARACTERES_RESULTADO = 24_000;
const CACHE_TTL_MS = 3 * 60_000;
const CACHE_MAX_ENTRADAS = 40;

const cacheBusqueda = new Map<string, { creadoEn: number; resultado: string }>();

function mimeDeterminista(mimeType: string | undefined): boolean {
  const mime = mimeType?.toLowerCase() ?? "";
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/rtf" ||
    mime === "application/vnd.google-apps.document" ||
    mime === "application/vnd.google-apps.spreadsheet" ||
    mime === "application/vnd.google-apps.presentation" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime.startsWith("application/vnd.oasis.opendocument.")
  );
}

export function puntuarResultadoDriveGlobal(resultado: DriveSearchResultGlobal, consulta: string): number {
  const terminos = terminosConocimiento(consulta);
  const nombre = normalizarConocimiento(resultado.name);
  const ruta = normalizarConocimiento(resultado.folderPath);
  let puntaje = 0;
  for (const termino of terminos) {
    if (nombre.includes(termino)) puntaje += 8 + Math.min(termino.length, 12);
    else if (ruta.includes(termino)) puntaje += 4;
  }
  // Preguntas de responsables, destinatarios o facturación suelen vivir en
  // documentos operativos con ese propósito. Es un boost, nunca una prueba:
  // el contenido real se lee y se devuelve con fuente antes de responder.
  if (/\b(responsab|quien|factur|destinat|direccion|contact)\w*/i.test(consulta) && /responsab/i.test(nombre)) {
    puntaje += 30;
  }
  if (mimeDeterminista(resultado.mimeType)) puntaje += 3;
  return puntaje;
}

export function ordenarResultadosDriveGlobal(
  resultados: DriveSearchResultGlobal[],
  consulta: string
): DriveSearchResultGlobal[] {
  return [...resultados].sort((a, b) => {
    const diferencia = puntuarResultadoDriveGlobal(b, consulta) - puntuarResultadoDriveGlobal(a, consulta);
    return diferencia || a.name.localeCompare(b.name);
  });
}

export function seleccionarResultadosDriveGlobal(
  resultados: DriveSearchResultGlobal[],
  consulta: string
): DriveSearchResultGlobal[] {
  const ordenados = ordenarResultadosDriveGlobal(resultados, consulta);
  const deterministas = ordenados.filter((resultado) => mimeDeterminista(resultado.mimeType));
  if (deterministas.length <= 1) return deterministas;
  const primero = puntuarResultadoDriveGlobal(deterministas[0], consulta);
  const segundo = puntuarResultadoDriveGlobal(deterministas[1], consulta);
  // Un ganador claro evita abrir libros o presentaciones que solo comparten
  // una palabra genérica. Si están próximos, se leen dos fuentes para no
  // convertir una heurística en una afirmación.
  return deterministas.slice(0, primero - segundo >= 5 ? 1 : MAX_FUENTES_DRIVE);
}

function acotarFuente(texto: string): string {
  if (texto.length <= MAX_CARACTERES_FUENTE) return texto;
  return `${texto.slice(0, MAX_CARACTERES_FUENTE)}\n\n[…fuente acotada; se puede ampliar con una consulta más específica…]`;
}

/**
 * Motor federado de conocimiento: en una única llamada consulta la memoria y
 * documentación operativa local, y el índice de contenido de Drive de las
 * tres empresas. Lee primero formatos deterministas; la visión/OCR queda como
 * último recurso para un solo PDF/imagen, evitando llamadas de IA innecesarias.
 */
export async function buscarConocimientoGlobal(consulta: string): Promise<string> {
  const claveCache = normalizarConocimiento(consulta).replace(/\s+/g, " ").trim();
  const ahora = Date.now();
  const cacheada = cacheBusqueda.get(claveCache);
  if (cacheada && ahora - cacheada.creadoEn < CACHE_TTL_MS) {
    const segundos = Math.max(1, Math.round((ahora - cacheada.creadoEn) / 1_000));
    return `[Frescura: búsqueda interna reutilizada de hace ${segundos} s; vigencia máxima 3 min.]\n\n${cacheada.resultado}`;
  }
  if (cacheada) cacheBusqueda.delete(claveCache);

  const [baseSettled, driveSettled] = await Promise.allSettled([
    consultarBaseConocimiento(
      { consulta },
      { ambito: "general", maxCaracteres: 8_000, soloCoincidencias: true }
    ),
    searchDriveFilesAllRoots(ROOT_FOLDERS, consulta, 6, 18),
  ]);

  const base = baseSettled.status === "fulfilled" ? baseSettled.value : "";
  const resultadosDrive = driveSettled.status === "fulfilled" ? driveSettled.value : [];
  const partes: string[] = [];
  if (base) partes.push(`## Memoria y documentación del proyecto\n\n${base}`);

  const ordenados = ordenarResultadosDriveGlobal(resultadosDrive, consulta);
  const seleccionados = seleccionarResultadosDriveGlobal(resultadosDrive, consulta);

  // Si Drive solo encontró PDF/imágenes y la documentación local no aportó
  // evidencia, se lee únicamente el mejor: una sola llamada visual como tope.
  const baseTieneEvidencia = base.length > 0 && !base.startsWith("No encontré fragmentos claramente relevantes");
  if (seleccionados.length === 0 && !baseTieneEvidencia && ordenados[0]) seleccionados.push(ordenados[0]);
  const deterministasOrdenados = ordenados.filter((resultado) => mimeDeterminista(resultado.mimeType));
  const candidatosLectura = [
    ...seleccionados,
    ...deterministasOrdenados.filter((resultado) => !seleccionados.some((elegido) => elegido.id === resultado.id)),
  ].slice(0, 4);
  const objetivoFuentes = Math.max(1, seleccionados.length);

  const contenidos: string[] = [];
  for (const resultado of candidatosLectura) {
    try {
      const contenido = await leerContenidoDrive(resultado, resultado.empresa, consulta);
      const puntajeContenido = puntuarTextoConocimiento(contenido, consulta);
      // Un candidato pudo aparecer por una palabra genérica indexada. Se
      // conserva el primero como evidencia de búsqueda; los siguientes solo
      // entran si el contenido tiene relación textual verificable.
      if (contenidos.length === 0 || puntajeContenido > 0) contenidos.push(acotarFuente(contenido));
      if (contenidos.length >= objetivoFuentes) break;
    } catch (error) {
      console.warn("[knowledge/global] lector Drive falló; continúa con las demás fuentes", {
        tipo: error instanceof Error ? error.name : "Error",
      });
    }
  }

  if (contenidos.length > 0) partes.push(`## Archivos de Google Drive leídos\n\n${contenidos.join("\n\n---\n\n")}`);
  else if (ordenados.length > 0) {
    partes.push(
      "## Archivos de Google Drive localizados\n\n" +
      ordenados.slice(0, 5).map((r) => `- ${r.name} — ${r.empresa}/${r.folderPath} — ${r.webViewLink}`).join("\n")
    );
  }

  if (driveSettled.status === "rejected") {
    partes.push("## Estado de Drive\n\nLa consulta de Drive falló en esta ejecución; la documentación y memoria local sí se revisaron.");
  }
  if (partes.length === 0) {
    return "La búsqueda federada no recuperó evidencia verificable para esta consulta.";
  }

  const resultado = partes.join("\n\n===\n\n");
  const acotado = resultado.length <= MAX_CARACTERES_RESULTADO
    ? resultado
    : `${resultado.slice(0, MAX_CARACTERES_RESULTADO)}\n\n[…resultado global acotado…]`;
  if (driveSettled.status === "fulfilled") {
    cacheBusqueda.set(claveCache, { creadoEn: ahora, resultado: acotado });
    if (cacheBusqueda.size > CACHE_MAX_ENTRADAS) {
      const primera = cacheBusqueda.keys().next().value as string | undefined;
      if (primera) cacheBusqueda.delete(primera);
    }
  }
  return acotado;
}

export const busquedaConocimientoGlobalTool: ToolDefinition = {
  name: "buscar_conocimiento_global",
  seguraParaModoRapido: true,
  description:
    "Buscador federado, proactivo y de solo lectura para preguntas internas del grupo. En una sola " +
    "operación consulta memoria/correcciones, documentación del proyecto y el contenido indexado de " +
    "Google Drive en WOBA, EWORKS y Footprint; además abre y lee los mejores archivos. Úsalo ANTES de " +
    "responder preguntas sobre responsables, clientes, proveedores, destinatarios de facturas, procesos, " +
    "direcciones, políticas o cualquier dato que razonablemente pueda estar en archivos internos. No le " +
    "preguntes al usuario si quiere que busques: busca directamente. Prioriza lectores sin IA para Google " +
    "Docs/Sheets/Slides, texto, Word, Excel, PowerPoint y OpenDocument; solo usa visión/OCR como último " +
    "recurso acotado para PDF/imágenes. Devuelve evidencia y enlaces de fuente; no inventa lo que no leyó. " +
    "Si el usuario identifica un correo concreto, complementa con revisar_correo_puntual para leer ese " +
    "correo y sus adjuntos reales.",
  input_schema: {
    type: "object",
    properties: {
      consulta: {
        type: "string",
        description: "Pregunta completa, conservando nombres propios, empresa, proveedor y dato buscado.",
      },
    },
    required: ["consulta"],
  },
  handler: async (input) => {
    const consulta = typeof input.consulta === "string" ? input.consulta.trim() : "";
    if (!consulta) return "Error: falta una consulta concreta.";
    return buscarConocimientoGlobal(consulta);
  },
};
