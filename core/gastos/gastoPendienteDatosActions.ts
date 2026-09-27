import type { InlineKeyboardButton } from "../telegram/types";

/** Teclado acotado y ligado a una pendiente exacta de verificacion. */
export function botonesVerificacionDuplicadoPendiente(id: string): InlineKeyboardButton[][] {
  return [
    [{ text: "🔄 Ya lo liberé: reprocesar", callback_data: `gpd_reintentar:${id}` }],
    [{ text: "➡️ Dejar pendiente y seguir", callback_data: `gpd_posponer:${id}` }],
    [{ text: "✅ Análisis correcto: cerrar y seguir", callback_data: `gpd_confirmar:${id}` }],
  ];
}

/** Un fallo técnico nunca se puede "confirmar como correcto": solo reintentar
 * la lectura o aplazar este correo sin tocar Holded y seguir con los demás. */
export function botonesFalloTemporalVerificacionPendiente(id: string): InlineKeyboardButton[][] {
  return [
    [{ text: "🔄 Reintentar verificación", callback_data: `gpd_reintentar:${id}` }],
    [{ text: "➡️ Dejar pendiente y seguir", callback_data: `gpd_posponer:${id}` }],
  ];
}
