import type { Empresa } from "../holded/client";
import { sendTelegramMessage } from "../telegram/client";
import { prepararCampanaSoportes } from "./campanaSoportes";
import { esExtractoRevolut } from "./extractoRevolut";

/**
 * Puerta de entrada del flujo de soportes: un CSV de movimientos de Revolut subido al chat NO es un documento para
 * archivar, es la entrada que dice qué cargos reclamar y a quién. Se detecta por sus columnas (no por el nombre) y la
 * empresa sale del texto que lo acompaña o del nombre del archivo. El CSV no se guarda en disco.
 */

export function pareceCsv(nombre: string | undefined, mime: string | undefined): boolean {
  return /\.csv$/i.test(nombre ?? "") || /csv/i.test(mime ?? "");
}

/** Empresa nombrada en el texto; undefined si no hay ninguna o hay varias (nunca se adivina). */
export function empresaDeTexto(...textos: Array<string | undefined>): Empresa | undefined {
  const t = textos.filter(Boolean).join(" ");
  const encontradas = new Set<Empresa>();
  if (/\bwoba\b/i.test(t)) encontradas.add("WOBA");
  if (/\be-?works\b/i.test(t)) encontradas.add("EWORKS");
  if (/\bfoot\s?print\b/i.test(t)) encontradas.add("Footprint");
  return encontradas.size === 1 ? [...encontradas][0] : undefined;
}

/** true si el archivo era un extracto de Revolut y ya se atendió (con éxito o con un aviso); false si no es de este flujo. */
export async function intentarExtractoRevolut(chatId: number, bytes: Buffer, nombre: string | undefined, mime: string | undefined, caption: string | undefined): Promise<boolean> {
  if (!pareceCsv(nombre, mime)) return false;
  const texto = bytes.toString("utf-8");
  if (!esExtractoRevolut(texto)) return false;

  const empresa = empresaDeTexto(caption, nombre);
  if (!empresa) {
    await sendTelegramMessage(chatId, "📄 Es un extracto de movimientos de Revolut, pero no sé de qué empresa es. Súbelo de nuevo con el nombre de la empresa en el texto (WOBA, EWORKS o Footprint).");
    return true;
  }
  await sendTelegramMessage(chatId, `🔎 Extracto de Revolut de ${empresa} recibido. Lo cruzo con Bancos de Holded para ver qué cargos siguen sin soporte (puede tardar un minuto)...`);
  try {
    await prepararCampanaSoportes(chatId, empresa, texto, nombre ?? "extracto.csv");
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[soportes] Error analizando el extracto:", mensaje);
    await sendTelegramMessage(chatId, `⚠️ No pude completar el análisis del extracto de ${empresa}: ${mensaje}\nNo se envió ni se pidió nada. Vuelve a subir el archivo para reintentar.`);
  }
  return true;
}
