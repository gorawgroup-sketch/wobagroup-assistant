import { transmitirMarin, VOZ_WOBI } from "../vozOpenAI/sintesis";

export const WOBI_VOICE = VOZ_WOBI;
export const MAX_VOICE_TEXT = 500;
export const VOICE_SAMPLE_RATE = 24_000;

export function textoParaVoz(texto: string): string {
  return texto.replace(/\bWOBI\b/gi, "Uóbi")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

export async function sintetizarVoz(texto: string, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await transmitirMarin(textoParaVoz(texto), signal, async audio => { chunks.push(audio); }, "mp3");
  return Buffer.concat(chunks);
}

export function transmitirVozPcm(texto: string, signal: AbortSignal, emitir: (audio: Buffer) => Promise<void>): Promise<void> {
  return transmitirMarin(textoParaVoz(texto), signal, emitir, "pcm");
}
