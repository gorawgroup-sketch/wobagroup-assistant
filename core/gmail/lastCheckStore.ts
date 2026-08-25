import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "gmail_ultimo_check.json");

// La primera vez que corre (sin estado previo), solo mira las últimas 24h
// hacia atrás — evita procesar años de historial del buzón.
const VENTANA_INICIAL_HORAS = 24;

export async function obtenerUltimoCheck(): Promise<number> {
  if (existsSync(STORE_PATH)) {
    try {
      const raw = await readFile(STORE_PATH, "utf-8");
      const data = JSON.parse(raw) as { ultimoCheck: number };
      if (typeof data.ultimoCheck === "number") return data.ultimoCheck;
    } catch {
      // cae al default
    }
  }

  return Math.floor(Date.now() / 1000) - VENTANA_INICIAL_HORAS * 3600;
}

export async function guardarUltimoCheck(timestampUnixSeconds: number): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify({ ultimoCheck: timestampUnixSeconds }, null, 2), "utf-8");
}
