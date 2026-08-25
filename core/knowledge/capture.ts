import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { formatDateLocal } from "../utils/dateFormat";

const STAGING_DIR = join(process.cwd(), "docs", "_staging");
const DOCS_DIR = join(process.cwd(), "docs");

export const CAPTURA_PREFIX = "CAPTURA:";

export function esMensajeCaptura(texto: string): boolean {
  return texto.trim().toUpperCase().startsWith(CAPTURA_PREFIX);
}

function extraerContenido(texto: string): string {
  return texto.trim().slice(CAPTURA_PREFIX.length).trim();
}

function rutaArchivoDeHoy(): string {
  return join(STAGING_DIR, `captura_${formatDateLocal(new Date())}.md`);
}

/**
 * Guarda un mensaje "CAPTURA: ..." en docs/_staging/captura_[fecha].md, con
 * timestamp. Acumula varias capturas del mismo día en el mismo archivo (no
 * sobrescribe). Funciona sin importar quién escriba — no valida remitente.
 */
export async function guardarCaptura(textoCompleto: string, autor?: string): Promise<void> {
  await mkdir(STAGING_DIR, { recursive: true });

  const contenido = extraerContenido(textoCompleto);
  const horaISO = new Date().toISOString();
  const ruta = rutaArchivoDeHoy();

  if (!existsSync(ruta)) {
    await appendFile(ruta, `# Capturas de conocimiento — ${formatDateLocal(new Date())}\n`, "utf-8");
  }

  const entrada = `\n### ${horaISO}${autor ? ` — ${autor}` : ""}\n\n${contenido}\n`;
  await appendFile(ruta, entrada, "utf-8");
}

export interface ArchivoCaptura {
  nombre: string;
  contenido: string;
}

/** Lista todos los archivos de captura pendientes (sin aprobar) en docs/_staging. */
export async function listarCapturasPendientes(): Promise<ArchivoCaptura[]> {
  if (!existsSync(STAGING_DIR)) return [];

  const nombres = (await readdir(STAGING_DIR)).filter((n) => n.endsWith(".md")).sort();

  const archivos: ArchivoCaptura[] = [];
  for (const nombre of nombres) {
    const contenido = await readFile(join(STAGING_DIR, nombre), "utf-8");
    archivos.push({ nombre, contenido });
  }

  return archivos;
}

/**
 * Mueve TODAS las capturas pendientes al archivo de conocimiento oficial
 * indicado (se crea si no existe) y borra los borradores ya incorporados.
 */
export async function aprobarYMoverCapturas(
  archivoDestino: string
): Promise<{ movidas: number; destino: string }> {
  const pendientes = await listarCapturasPendientes();
  if (pendientes.length === 0) {
    return { movidas: 0, destino: archivoDestino };
  }

  const nombreSanitizado = archivoDestino.trim().replace(/[^\w.\-]+/g, "_");
  const nombreFinal = nombreSanitizado.endsWith(".md") ? nombreSanitizado : `${nombreSanitizado}.md`;
  const rutaDestino = join(DOCS_DIR, nombreFinal);

  let bloque = `\n\n## Capturas incorporadas el ${formatDateLocal(new Date())}\n`;
  for (const archivo of pendientes) {
    bloque += `\n${archivo.contenido}\n`;
  }

  await appendFile(rutaDestino, bloque, "utf-8");

  for (const archivo of pendientes) {
    await unlink(join(STAGING_DIR, archivo.nombre));
  }

  return { movidas: pendientes.length, destino: rutaDestino };
}
