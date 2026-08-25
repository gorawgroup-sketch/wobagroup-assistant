/**
 * Lista de usuarios de Telegram autorizados a usar el asistente. Falla
 * cerrado: si TELEGRAM_ALLOWED_USER_IDS no está configurada (o está vacía),
 * NADIE queda autorizado — nunca se revierte silenciosamente a acceso
 * abierto por una variable de entorno faltante.
 */
function obtenerUsuariosAutorizados(): Set<number> {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));

  return new Set(ids);
}

export function esUsuarioAutorizado(userId: number | undefined): boolean {
  if (!userId) return false;
  return obtenerUsuariosAutorizados().has(userId);
}
