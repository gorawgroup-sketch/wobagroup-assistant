import { registrarCaptura } from "./capturaSheet";

// La palabra clave "CAPTURA" dispara la captura sin importar dónde aparezca
// en el mensaje (al inicio, al final, con o sin dos puntos) — se guarda el
// mensaje completo tal cual, no hace falta un formato estricto.
const CAPTURA_KEYWORD = /\bCAPTURA\b/i;

export function esMensajeCaptura(texto: string): boolean {
  return CAPTURA_KEYWORD.test(texto);
}

/**
 * Guarda el mensaje completo en la pestaña oculta `_capturas` del Sheet de
 * cashflow (ver capturaSheet.ts) — nunca en disco local, que no sobrevive un
 * redeploy de Railway. Sin paso de revisión ni aprobación: si se captura, se
 * asume ya validado por quien la mandó. Funciona sin importar quién escriba
 * — no valida remitente.
 */
export async function guardarCaptura(textoCompleto: string, autor?: string): Promise<void> {
  await registrarCaptura(textoCompleto, autor);
}
