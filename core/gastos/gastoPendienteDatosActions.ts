import type { InlineKeyboardButton } from "../telegram/types";

/** Teclado acotado y ligado a una pendiente exacta de verificacion. */
export function botonesVerificacionDuplicadoPendiente(id: string): InlineKeyboardButton[][] {
  return [
    [{ text: "🔄 Ya lo liberé: reprocesar", callback_data: `gpd_reintentar:${id}` }],
    [{ text: "✅ Análisis correcto: cerrar y seguir", callback_data: `gpd_confirmar:${id}` }],
  ];
}
