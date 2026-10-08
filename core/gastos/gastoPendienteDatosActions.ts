import type { InlineKeyboardButton } from "../telegram/types";

/** Teclado acotado y ligado a una pendiente exacta de verificacion. */
export function botonesVerificacionDuplicadoPendiente(id: string): InlineKeyboardButton[][] {
  return [
    [{ text: "🔄 Ya lo liberé: reprocesar", callback_data: `gpd_reintentar:${id}` }],
    [{ text: "➡️ Dejar pendiente y seguir", callback_data: `gpd_posponer:${id}` }],
    [{ text: "✅ Análisis correcto: cerrar y seguir", callback_data: `gpd_confirmar:${id}` }],
    // Norma de resolución autónoma (Carlos, 08-10-2026, recibo de Anthropic): el cargo de hoy llega al banco mañana y el
    // movimiento «probable» ya conciliado es otro. Sin esta salida, no había forma de crear el gasto y conciliarlo después.
    [{ text: "➕ Crear el gasto ahora, sin conciliar (el cargo llega después)", callback_data: `gpd_crear:${id}` }],
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
