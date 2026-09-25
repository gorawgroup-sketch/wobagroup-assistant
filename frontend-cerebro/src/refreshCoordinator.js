/**
 * Motivos que exigen otra lectura si llegan mientras hay una en curso (algo pudo cambiar después de que empezara).
 * NO implica forzar al servidor: ver fuerzaLecturaNueva.
 */
export const necesitaLecturaNueva = motivo => ["manual", "entrada", "visibilidad", "online", "reconexion", "evento"].includes(motivo);

/**
 * Solo el botón «actualizar» del usuario obliga al servidor a recalcular (~3 s). Entrar, volver a la pestaña,
 * reconectar y los avisos en tiempo real leen lo último que tiene el servidor (respuesta al instante): antes cada
 * uno forzaba un recálculo completo de ~38 s en cada pestaña abierta, y esa avalancha era la causa de la lentitud.
 */
export const fuerzaLecturaNueva = motivo => motivo === "manual";

/** No pierde una orden manual ni un cambio recibido durante otra lectura. */
export function createRefreshCoordinator(run, timeoutMs = 90_000) {
  let running;
  let queued;
  let controller;
  let disposed = false;
  const refresh = (motivo = "manual") => {
    if (disposed) return Promise.resolve(false);
    if (running) {
      if (necesitaLecturaNueva(motivo)) queued = motivo;
      return running;
    }
    running = Promise.resolve().then(async () => {
      let next = motivo;
      let result;
      do {
        queued = undefined;
        controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("La consulta tardó demasiado", "TimeoutError")), timeoutMs);
        try { result = await run(next, controller.signal); }
        finally { clearTimeout(timer); }
        next = queued;
      } while (next && !disposed);
      return result;
    }).finally(() => { running = undefined; controller = undefined; });
    return running;
  };
  return { refresh, activate() { disposed = false; }, dispose() { disposed = true; queued = undefined; controller?.abort(); } };
}

export function estadoFrescura(data, now = Date.now()) {
  const fecha = Date.parse(data?.cacheadoEn || "");
  if (!Number.isFinite(fecha)) return "pendiente";
  if (data.actualizacionParcial) return "parcial";
  return now - fecha > 90_000 ? "antiguo" : "reciente";
}
