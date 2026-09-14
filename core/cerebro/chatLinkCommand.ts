/**
 * Acepta tanto el comando escrito a mano como los payloads de enlaces
 * profundos de Telegram. Los códigos se normalizan después en el store.
 */
export function extraerCodigoVinculoChat(texto: string): string | undefined {
  const limpio = texto.trim();
  const manual = limpio.match(/^\/?vincular\s+([a-zA-Z0-9-]{6,8})$/i)?.[1];
  if (manual) return manual;

  const profundo = limpio.match(/^\/start(?:@[a-zA-Z0-9_]+)?\s+(?:vincular|link)[_-]([a-zA-Z0-9-]{6,8})$/i)?.[1];
  return profundo || undefined;
}
