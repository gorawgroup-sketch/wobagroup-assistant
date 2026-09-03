import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { searchDriveFiles, descargarArchivoDrive, palabrasSignificativas, type DriveSearchResult } from "../drive/client";
import { ROOT_FOLDERS, type EmpresaConCarpeta } from "../drive/rootFolders";
import { transcribirParaCaptura } from "../documental/transcribeForCapture";
import type { ToolDefinition } from "./types";

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150);
}

/**
 * Bug real encontrado en vivo (2026-09-01), corregido dos veces la misma
 * sesión: una búsqueda con varias palabras (ej. "control de accesos") a
 * veces devuelve muchos resultados (una palabra suelta como "control" es
 * común), y aunque el resultado correcto está justo ahí en la lista (ej.
 * "guia rapida control accesos.pdf"), Claude se quedaba pidiéndole al
 * usuario que confirmara un nombre que él mismo ya le había mostrado.
 *
 * Primer intento de arreglo: exigir que el mejor candidato contuviera
 * TODAS las palabras significativas de la consulta. Se rompió en la
 * primera prueba real: Carlos preguntó "control de accesos DE LA OFICINA"
 * — la palabra "oficina" es significativa pero no aparece en el nombre
 * real del archivo ("guia rapida control accesos.pdf"), así que exigir el
 * 100% de las palabras seguía fallando aunque el archivo correcto tuviera,
 * por lejos, más coincidencias que cualquier otro candidato.
 *
 * Ahora es puntaje RELATIVO (mismo principio que puntuarDistintividad en
 * core/holded/write.ts para contactos de Holded): suma la longitud de
 * cada palabra significativa que aparece en el nombre (no solo cuenta),
 * y elige el candidato con más puntaje SIEMPRE que nadie más lo empate —
 * nunca exige un match perfecto, solo un ganador claro. Verificado en vivo
 * con la consulta real que falló ("control de accesos de la oficina"):
 * el archivo correcto suma 14 (control+accesos) contra 7 (solo "control")
 * de cualquier otro candidato — gana claro, sin necesitar "oficina".
 */
function elegirMejorCandidato(resultados: DriveSearchResult[], consulta: string): DriveSearchResult | undefined {
  const palabrasConsulta = palabrasSignificativas(consulta);
  if (palabrasConsulta.length === 0) return undefined;

  const puntuados = resultados.map((r) => {
    const nombreNormalizado = r.name.toLowerCase();
    const score = palabrasConsulta
      .filter((p) => nombreNormalizado.includes(p))
      .reduce((suma, p) => suma + p.length, 0);
    return { resultado: r, score };
  });

  puntuados.sort((a, b) => b.score - a.score);

  const mejor = puntuados[0];
  const segundo = puntuados[1];

  // Gana claro: tiene que haber al menos una palabra significativa real
  // (score > 0) y nadie más puede empatarlo — un empate real sigue siendo
  // ambiguo, nunca se decide al azar.
  if (mejor.score > 0 && (!segundo || segundo.score < mejor.score)) {
    return mejor.resultado;
  }
  return undefined;
}

async function leerContenido(
  resultado: DriveSearchResult,
  empresa: EmpresaConCarpeta,
  consulta: string
): Promise<string> {
  const mimesLegibles = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!resultado.mimeType || !mimesLegibles.includes(resultado.mimeType)) {
    return (
      `Encontré "${resultado.name}" (${resultado.folderPath}) pero es de un tipo que no puedo leer ` +
      `todavía (${resultado.mimeType ?? "desconocido"} — solo PDF/imagen por ahora). Link: ${resultado.webViewLink}`
    );
  }

  let rutaLocal: string | undefined;
  try {
    const archivo = await descargarArchivoDrive(resultado.id);
    await mkdir(UPLOADS_DIR, { recursive: true });
    rutaLocal = join(UPLOADS_DIR, `${Date.now()}_${sanitizarNombre(archivo.name)}`);
    await writeFile(rutaLocal, archivo.bytes);

    const texto = await transcribirParaCaptura(
      rutaLocal,
      archivo.mimeType,
      `Documento archivado en Drive (${empresa}, ${resultado.folderPath}), leído porque el usuario preguntó sobre "${consulta}".`
    );

    return `📄 Contenido de "${resultado.name}" (${resultado.folderPath}, ${resultado.webViewLink}):\n\n${texto}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Encontré "${resultado.name}" pero hubo un error leyendo su contenido: ${message}. Link para abrirlo a mano: ${resultado.webViewLink}`;
  } finally {
    if (rutaLocal) await unlink(rutaLocal).catch(() => {});
  }
}

/**
 * Pedido explícito de Carlos, tras un caso real: un documento ya archivado
 * en Drive ("guía rápida de control de accesos") existía y era exactamente
 * lo que preguntaba, pero buscar_documento_drive solo dice DÓNDE está un
 * archivo (nombre + link), nunca su contenido — así que Wobi no podía
 * responder la pregunta real con esa info, solo señalar que el archivo
 * existe. Esta tool cierra ese hueco: busca, y si hay un único resultado
 * claro (o si hay un ganador claro por puntaje frente al resto, ver
 * elegirMejorCandidato — nunca exige un match perfecto), lo descarga y lee su contenido real con
 * Claude vision (mismo mecanismo que transcribirParaCaptura, ya usado para
 * CAPTURA) — para que Wobi pueda responder con la información real, no
 * solo con un link para que el usuario mismo lo abra.
 *
 * Si de verdad hay ambigüedad real (varios candidatos igual de plausibles),
 * nunca elige sola — los lista para que el usuario confirme cuál, mismo
 * principio que el resto del proyecto (nunca asumir sin evidencia clara).
 * Solo lee PDF/imagen (lo que Claude vision soporta) — un Google Doc/Sheet
 * nativo no está soportado todavía.
 */
export const leerDocumentoDriveTool: ToolDefinition = {
  name: "leer_documento_drive",
  seguraParaModoRapido: true,
  description:
    "Busca un documento en Drive por nombre/tema Y LEE SU CONTENIDO REAL (no solo dónde está) — úsala " +
    "cuando alguien pregunte algo cuya respuesta podría estar DENTRO de un documento ya archivado (ej. " +
    "'guía de control de accesos', 'política de vacaciones', 'contrato de X', 'cuál es el NIF de la " +
    "empresa', cualquier dato/condición/número concreto), especialmente si consultar_base_conocimiento " +
    "no encontró nada: antes de decir 'no tengo información' o 'necesito más herramientas', prueba " +
    "esta tool con palabras clave del tema (y si no sabes la empresa, prueba con las 3) — un documento " +
    "puede estar archivado en Drive sin haber sido transcrito nunca a la base de conocimiento. IMPORTANTE: " +
    "si ya usaste buscar_documento_drive/listar_carpetas_drive y solo tienes el NOMBRE de un archivo " +
    "(no su contenido), eso NO es suficiente para responder una pregunta de contenido — sigue con esta " +
    "tool pasando ese mismo nombre como consulta, en vez de responder con el link o pedir escalar. " +
    "Solo lee PDF o " +
    "imágenes (no Google Docs/Sheets nativos todavía). Si la búsqueda devuelve varios resultados pero " +
    "uno de ellos se distingue claramente del resto (no hace falta que coincida con el 100% de tu " +
    "consulta, solo que gane por lejos), esta tool lo elige y lee sola automáticamente — no hace falta " +
    "que la vuelvas a llamar. Solo te pide confirmar cuando de " +
    "verdad hay ambigüedad real entre varios candidatos igual de plausibles — en ese caso SÍ debes " +
    "preguntarle al usuario cuál es (nunca elegir tú mismo), y puedes volver a llamar esta tool pasando " +
    "el nombre exacto que el usuario confirme.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint"],
        description: "Empresa del grupo cuya carpeta raíz de Drive se consulta.",
      },
      consulta: {
        type: "string",
        description: "Término de búsqueda por nombre de archivo, o el nombre exacto si ya se conoce.",
      },
    },
    required: ["empresa", "consulta"],
  },
  handler: async (input) => {
    const empresa = input.empresa as EmpresaConCarpeta;
    if (!ROOT_FOLDERS[empresa]) {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const consulta = typeof input.consulta === "string" ? input.consulta.trim() : "";
    if (!consulta) {
      return "Error: falta el término de búsqueda ('consulta').";
    }

    const rootFolderId = ROOT_FOLDERS[empresa];
    const resultados = await searchDriveFiles(rootFolderId, consulta);

    if (resultados.length === 0) {
      return `No encontré ningún archivo que coincida con "${consulta}" en la carpeta de ${empresa}.`;
    }

    if (resultados.length === 1) {
      return leerContenido(resultados[0], empresa, consulta);
    }

    const mejorCandidato = elegirMejorCandidato(resultados, consulta);
    if (mejorCandidato) {
      return leerContenido(mejorCandidato, empresa, consulta);
    }

    const lista = resultados.map((r) => `- ${r.name} — ${r.folderPath}`).join("\n");
    return (
      `Encontré ${resultados.length} archivos que podrían coincidir con "${consulta}" en ${empresa}, ` +
      `ninguno se distingue claramente del resto — no voy a elegir solo, pregúntale al usuario cuál es, ` +
      `y vuelve a llamar esta tool con el nombre exacto en 'consulta':\n${lista}`
    );
  },
};
