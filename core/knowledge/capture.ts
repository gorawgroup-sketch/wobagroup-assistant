import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { invalidarCacheConocimiento } from "./loader";

const KNOWLEDGE_FILE = join(process.cwd(), "docs", "conocimiento_capturado.md");

export const CAPTURA_PREFIX = "CAPTURA:";

export function esMensajeCaptura(texto: string): boolean {
  return texto.trim().toUpperCase().startsWith(CAPTURA_PREFIX);
}

function extraerContenido(texto: string): string {
  return texto.trim().slice(CAPTURA_PREFIX.length).trim();
}

/**
 * Guarda un mensaje "CAPTURA: ..." directo en docs/conocimiento_capturado.md
 * (parte del conocimiento oficial: consultar_base_conocimiento lee todos
 * los .md de /docs) e invalida la caché al instante, así queda disponible
 * en la siguiente pregunta sin reiniciar el proceso. Sin paso de revisión
 * ni aprobación: si se captura, se asume ya validado por quien la mandó.
 * Funciona sin importar quién escriba — no valida remitente.
 */
export async function guardarCaptura(textoCompleto: string, autor?: string): Promise<void> {
  const contenido = extraerContenido(textoCompleto);
  const horaISO = new Date().toISOString();

  if (!existsSync(KNOWLEDGE_FILE)) {
    await appendFile(
      KNOWLEDGE_FILE,
      "# Conocimiento capturado\n\nInformación reportada directamente por el equipo vía Telegram (prefijo CAPTURA:), integrada sin revisión adicional.\n",
      "utf-8"
    );
  }

  const entrada = `\n### ${horaISO}${autor ? ` — ${autor}` : ""}\n\n${contenido}\n`;
  await appendFile(KNOWLEDGE_FILE, entrada, "utf-8");

  invalidarCacheConocimiento();
}
