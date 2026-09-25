/**
 * Última lectura del panel guardada en el navegador, para pintarla al instante al recargar mientras se pide la
 * nueva (medido el 2026-09-25: la recarga esperaba ~38 s a que el servidor recalculara todo antes de mostrar nada).
 *
 * - Vinculada a una huella del token: nunca se muestra la lectura de otra sesión.
 * - Caduca a las 12 h: un dato de ayer no se pinta como si sirviera; el panel dice siempre «datos consultados hace X».
 * - Todo va envuelto: localStorage puede fallar (modo privado, cuota, bloqueado) y nunca debe romper el panel.
 */
export const CLAVE_SNAPSHOT_LOCAL = "wobi_cerebro_snapshot_v1";
export const EDAD_MAXIMA_SNAPSHOT_MS = 12 * 60 * 60 * 1000;
const TAMANO_MAXIMO_CARACTERES = 600_000;

/** Huella corta y no reversible a la vista del token (no es un hash criptográfico: solo distingue sesiones). */
export function huellaToken(token) {
  let h = 5381;
  const texto = String(token ?? "");
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0") + texto.length.toString(16);
}

export function guardarSnapshotLocal(almacen, token, datos, ahora = Date.now()) {
  try {
    if (!almacen || !token || !datos || typeof datos !== "object") return false;
    const crudo = JSON.stringify({ huella: huellaToken(token), guardadoEn: ahora, datos });
    if (crudo.length > TAMANO_MAXIMO_CARACTERES) return false;
    almacen.setItem(CLAVE_SNAPSHOT_LOCAL, crudo);
    return true;
  } catch {
    return false;
  }
}

/** Devuelve la lectura guardada si es de esta sesión, tiene forma válida y no está caducada; si no, null. */
export function leerSnapshotLocal(almacen, token, ahora = Date.now()) {
  try {
    if (!almacen || !token) return null;
    const crudo = almacen.getItem(CLAVE_SNAPSHOT_LOCAL);
    if (!crudo) return null;
    const guardado = JSON.parse(crudo);
    if (!guardado || guardado.huella !== huellaToken(token)) return null;
    if (!Number.isFinite(guardado.guardadoEn) || ahora - guardado.guardadoEn > EDAD_MAXIMA_SNAPSHOT_MS || guardado.guardadoEn > ahora + 60_000) return null;
    const datos = guardado.datos;
    if (!datos || typeof datos !== "object" || !Number.isFinite(Date.parse(datos.cacheadoEn || ""))) return null;
    return datos;
  } catch {
    return null;
  }
}

export function borrarSnapshotLocal(almacen) {
  try { almacen?.removeItem(CLAVE_SNAPSHOT_LOCAL); } catch { /* no crítico */ }
}
