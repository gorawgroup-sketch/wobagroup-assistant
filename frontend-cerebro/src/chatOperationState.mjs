const ESTADOS_TERMINALES = new Set(["completado", "incierto", "fallido"]);

/** Cerrojo sincrónico para bloquear un doble clic antes del próximo render. */
export function crearBloqueoOperaciones() {
  const ids = new Set();
  return {
    intentar(id) {
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    },
    liberar(id) { ids.delete(id); },
    contiene(id) { return ids.has(id); },
  };
}

/** Una solicitud activa todavía debe recuperarse por evento o comprobación de respaldo. */
export function solicitudChatActiva(solicitud) {
  return Boolean(solicitud) && !ESTADOS_TERMINALES.has(solicitud.estado);
}

/**
 * Una decisión no confirmada conserva bloqueado su mensaje original. Esto
 * incluye el estado incierto: cerrarla o recargar el navegador jamás debe
 * fabricar un segundo intento con otro identificador.
 */
export function solicitudBloqueaBoton(solicitud) {
  return Boolean(
    solicitud &&
    solicitud.tipo === "boton" &&
    solicitud.origenMessageId &&
    solicitud.estado !== "completado"
  );
}

export function etiquetaEstadoSolicitud(solicitud) {
  if (solicitud?.estado === "registrando" || solicitud?.estado === "en_cola") return "En cola";
  if (solicitud?.estado === "aplicado") return "Aplicado · verificando resultado";
  if (solicitud?.estado === "verificando") return "Reconectando · sin repetir";
  if (solicitud?.estado === "completado") return "Finalizado";
  if (solicitud?.estado === "incierto") return "Resultado incierto · repetición bloqueada";
  if (solicitud?.estado === "fallido") return "Interrumpido · repetición bloqueada";
  return "Procesando";
}

export function tonoEstadoSolicitud(solicitud) {
  if (solicitud?.estado === "incierto" || solicitud?.estado === "fallido") return "alerta";
  if (solicitud?.estado === "aplicado" || solicitud?.estado === "verificando") return "verificando";
  if (solicitud?.estado === "completado") return "listo";
  return "activo";
}
