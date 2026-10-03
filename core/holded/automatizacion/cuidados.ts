/**
 * Cuidados para que el usuario de WOBI en Holded (rol Administrador) NO pueda perjudicar la contabilidad aunque algo falle:
 * lo que el rol permitiría se recorta aquí, en el propio navegador de WOBI. Funciones puras para poder probarlas.
 */

/** Etiquetas de botones que el sistema nunca pulsa. */
const ETIQUETA_PROHIBIDA = /elimin|\bborrar\b|delete|remove|suprimir|anular|cancelar suscrip|cerrar (el )?(periodo|ejercicio)|invitar|desactivar usuario|dar de baja|desconectar|reconectar/i;

export function etiquetaPermitida(etiqueta: string): boolean { return !ETIQUETA_PROHIBIDA.test(etiqueta); }

/** Lanza si alguna etiqueta a pulsar está prohibida: un error de programación nunca debe llegar a borrar nada. */
export function exigirEtiquetasPermitidas(etiquetas: readonly string[]): void {
  const mala = etiquetas.find((e) => !etiquetaPermitida(e));
  if (mala) throw new Error(`Etiqueta de botón prohibida para WOBI: «${mala}»`);
}

/** Zonas de la aplicación sobre las que WOBI nunca escribe (usuarios, suscripción, facturación, cierre de periodos, API keys). */
const RUTA_PROHIBIDA = /\/(subscriptions?|billing|invit(e|ations?)|close-?period|fiscal-?year|accounting-?period|api-?keys?|team\/(add|remove|delete)|users?\/(add|invite|create|delete|remove|update|role|permission)s?)\b/i;

/**
 * true si la petición del navegador debe bloquearse: cualquier DELETE, y cualquier escritura (no GET/HEAD/OPTIONS) sobre las
 * zonas prohibidas. Las lecturas siempre pasan, y también las escrituras normales de las dos tareas permitidas.
 */
export function esSolicitudPeligrosa(metodo: string, url: string): boolean {
  const m = metodo.toUpperCase();
  if (m === "DELETE") return true;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  let ruta = url;
  try { ruta = new URL(url).pathname; } catch { /* url relativa */ }
  return RUTA_PROHIBIDA.test(ruta);
}

/** Topes de seguridad (por ciclo y por día): un fallo no puede convertirse en un cambio masivo. */
export const MAX_CONVERSIONES_POR_CICLO = 10;
export const MAX_CONVERSIONES_POR_DIA = 40;
/** Casos del día que terminan con cambios INESPERADOS en Holded a partir de los cuales la conversión se detiene sola. */
export const UMBRAL_DISYUNTOR = 2;
