export type Rol = "admin" | "colaborador";

/**
 * Lista de usuarios de Telegram autorizados, con nivel de acceso. Formato de
 * TELEGRAM_ALLOWED_USER_IDS: "id:rol,id:rol,..." (ej. "111:admin,222:colaborador").
 * Falla cerrado: si la variable no está configurada (o está vacía), NADIE
 * queda autorizado — nunca se revierte silenciosamente a acceso abierto por
 * una variable de entorno faltante. Un id sin ":rol" válido se trata como
 * "colaborador" (el nivel más restringido), nunca como "admin" por defecto.
 */
function obtenerUsuariosAutorizados(): Map<number, Rol> {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "";
  const mapa = new Map<number, Rol>();

  for (const par of raw.split(",")) {
    const [idRaw, rolRaw] = par.split(":").map((s) => s.trim());
    const id = Number(idRaw);
    if (!idRaw || !Number.isFinite(id)) continue;

    const rol: Rol = rolRaw === "admin" ? "admin" : "colaborador";
    mapa.set(id, rol);
  }

  return mapa;
}

/** Devuelve el rol del usuario, o undefined si no está en la lista de autorizados. */
export function obtenerRol(userId: number | undefined): Rol | undefined {
  if (!userId) return undefined;
  return obtenerUsuariosAutorizados().get(userId);
}

export function esUsuarioAutorizado(userId: number | undefined): boolean {
  return obtenerRol(userId) !== undefined;
}

// Acciones (prefijo de callback_data antes de ":") que disparan una escritura
// real (Holded, cashflow, envío de correo, subida a Drive) — solo "admin"
// puede presionarlas. Descartar/cancelar/rechazar/pedir orientación siempre
// queda disponible para cualquier usuario autorizado, porque no escribe nada.
const ACCIONES_SENSIBLES = new Set(["cf_approve", "recpago_confirmar", "draft_enviar", "doc_confirm"]);

export function esAccionSensible(callbackData: string): boolean {
  const [accion] = callbackData.split(":");
  return ACCIONES_SENSIBLES.has(accion);
}
