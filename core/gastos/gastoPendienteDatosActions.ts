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

/** Un cargo que se ofrece como posible pago real del documento (lo mínimo para mostrarlo y para reanudar con él). */
export interface CargoOfrecido {
  monto: number;
  moneda: string;
  /** YYYY-MM-DD */
  fecha: string;
  descripcion: string;
}

/** Como mucho este número de cargos se ofrece con botón: coincide con el tope de la búsqueda por tipo de cambio. */
export const MAX_CARGOS_CON_BOTON = 5;

const diaMesCorto = (fecha: string): string => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(fecha);
  return m ? `${m[2]}/${m[1]}` : fecha || "s/f";
};

/** callback_data del cargo elegido: id de la pendiente + céntimos + moneda (cabe de sobra en los 64 bytes de Telegram). */
export function codificarCargoElegido(id: string, cargo: Pick<CargoOfrecido, "monto" | "moneda">): string {
  return `gpd_cargo:${id}:${Math.round(Math.abs(cargo.monto) * 100)}:${cargo.moneda.toUpperCase().trim()}`;
}

/** Lee el callback_data de un cargo elegido; null si no es válido (nunca se reanuda con un importe dudoso). */
export function parsearCargoElegido(data: string): { id: string; monto: number; moneda: string } | null {
  const m = /^gpd_cargo:([A-Za-z0-9_-]{1,16}):(\d{1,10}):([A-Z]{3})$/.exec(data);
  if (!m) return null;
  const monto = Number(m[2]) / 100;
  return Number.isFinite(monto) && monto > 0 ? { id: m[1], monto, moneda: m[3] } : null;
}

/**
 * Documento ya leído que espera a que el banco muestre el cargo (p. ej. Anthropic: factura en USD, tarjeta en EUR).
 * Sin esto la pendiente no tenía ninguna vía de reanudación y el correo quedaba «activo» sin pregunta que contestar.
 * Reintentar es siempre una decisión de la persona: ninguna búsqueda automática por retraso del banco.
 */
export function botonesEsperaBancaria(id: string, deColaCorreo: boolean): InlineKeyboardButton[][] {
  const filas: InlineKeyboardButton[][] = [[{ text: "🔄 Buscar el cargo otra vez", callback_data: `gpd_reintentar:${id}` }]];
  if (deColaCorreo) filas.push([{ text: "➡️ Dejar pendiente y seguir", callback_data: `gpd_posponer:${id}` }]);
  return filas;
}

/**
 * Factura en una moneda que no es de ninguna cuenta (p. ej. MXN) con varios cargos posibles: un botón por cargo que
 * reanuda la misma pendiente con el importe y la moneda REALES de ese cargo (el mismo camino que escribirlos a mano),
 * más «buscar otra vez» y, si viene de la cola de correo, «dejar pendiente y seguir».
 */
export function botonesCargosCandidatos(id: string, cargos: CargoOfrecido[], deColaCorreo: boolean): InlineKeyboardButton[][] {
  const filas: InlineKeyboardButton[][] = cargos.slice(0, MAX_CARGOS_CON_BOTON).map((c, i) => {
    const etiqueta = `${i + 1}) ${Math.abs(c.monto).toFixed(2)} ${c.moneda} · ${diaMesCorto(c.fecha)} · ${c.descripcion.replace(/\s+/g, " ").trim()}`;
    return [{ text: etiqueta.length > 56 ? `${etiqueta.slice(0, 55)}…` : etiqueta, callback_data: codificarCargoElegido(id, c) }];
  });
  return [...filas, ...botonesEsperaBancaria(id, deColaCorreo)];
}

