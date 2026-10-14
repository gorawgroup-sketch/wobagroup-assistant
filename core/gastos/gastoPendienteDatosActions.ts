import type { InlineKeyboardButton } from "../telegram/types";

/** Teclado acotado y ligado a una pendiente exacta de verificacion. */
export function botonesVerificacionDuplicadoPendiente(id: string): InlineKeyboardButton[][] {
  return [
    // Rótulos que dicen qué hace cada botón (Carlos, 14-10-2026: «los botones no me dicen mucho»).
    [{ text: "➕ Es otro cargo: crear el gasto (concilio después)", callback_data: `gpd_crear:${id}` }],
    [{ text: "🔄 Volver a comprobar el banco y reprocesar", callback_data: `gpd_reintentar:${id}` }],
    [{ text: "✅ Ya estaba registrado: cerrar este correo", callback_data: `gpd_confirmar:${id}` }],
    [{ text: "➡️ Aplazar este correo y seguir con la cola", callback_data: `gpd_posponer:${id}` }],
  ];
}

/** Un fallo técnico nunca se puede "confirmar como correcto": solo reintentar
 * la lectura o aplazar este correo sin tocar Holded y seguir con los demás. */
export function botonesFalloTemporalVerificacionPendiente(id: string): InlineKeyboardButton[][] {
  return [
    [{ text: "🔄 Reintentar la verificación en Holded", callback_data: `gpd_reintentar:${id}` }],
    [{ text: "➡️ Aplazar este correo y seguir con la cola", callback_data: `gpd_posponer:${id}` }],
  ];
}
