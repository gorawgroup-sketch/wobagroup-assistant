import { useEffect, useRef } from "react";

const STREAM_ENDPOINT = "/api/cerebro/stream";
const REFRESH_FALLBACK_MS = 30_000;
const RETRY_MAX_MS = 30_000;

function authHeaders(apiKey) {
  return apiKey ? { "X-Cerebro-Key": apiKey } : {};
}

/**
 * Mantiene el panel sincronizado sin recargar el navegador:
 * - recibe invalidaciones inmediatas por SSE con un fetch autenticado;
 * - conserva polling liviano como respaldo ante reinicios o varias réplicas;
 * - pausa todo en segundo plano y actualiza al volver a la pestaña;
 * - reconecta con backoff, sin bucles agresivos si Railway o la red caen.
 */
export function useCerebroRealtime({ apiKey, onRefresh, onStatus }) {
  const refreshRef = useRef(onRefresh);
  const statusRef = useRef(onStatus);

  useEffect(() => {
    refreshRef.current = onRefresh;
    statusRef.current = onStatus;
  }, [onRefresh, onStatus]);

  useEffect(() => {
    if (!apiKey) {
      statusRef.current?.("desconectado");
      return undefined;
    }

    let detenido = false;
    let controller = null;
    let reintentoId = null;
    let intentos = 0;
    let conectadoAlgunaVez = false;

    const estaVisible = () => document.visibilityState === "visible";

    const refrescar = (motivo) => {
      if (!detenido && estaVisible()) return refreshRef.current?.(motivo);
      return undefined;
    };

    const programarReconexion = () => {
      if (detenido || !estaVisible() || !navigator.onLine || reintentoId) return;
      const espera = Math.min(1_000 * 2 ** Math.min(intentos, 5), RETRY_MAX_MS);
      reintentoId = window.setTimeout(() => {
        reintentoId = null;
        conectar();
      }, espera);
    };

    const procesarBloque = (bloque) => {
      let tipo = "message";
      let data = "";
      for (const linea of bloque.split("\n")) {
        if (linea.startsWith("event:")) tipo = linea.slice(6).trim();
        if (linea.startsWith("data:")) data += linea.slice(5).trim();
      }
      if (tipo === "actualizar" && data) refrescar("evento");
    };

    const conectar = async () => {
      if (detenido || !estaVisible() || !navigator.onLine || controller) return;
      controller = new AbortController();
      statusRef.current?.(intentos === 0 ? "conectando" : "reconectando");

      try {
        const res = await fetch(STREAM_ENDPOINT, {
          headers: authHeaders(apiKey),
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream_${res.status}`);

        const esReconexion = conectadoAlgunaVez;
        conectadoAlgunaVez = true;
        intentos = 0;
        statusRef.current?.("en_vivo");
        if (esReconexion) refrescar("reconexion");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let pendiente = "";

        while (!detenido) {
          const { value, done } = await reader.read();
          if (done) break;
          pendiente += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let separador = pendiente.indexOf("\n\n");
          while (separador >= 0) {
            procesarBloque(pendiente.slice(0, separador));
            pendiente = pendiente.slice(separador + 2);
            separador = pendiente.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (!detenido && error?.name !== "AbortError") {
          intentos += 1;
          statusRef.current?.(navigator.onLine ? "reconectando" : "sin_conexion");
        }
      } finally {
        controller = null;
        programarReconexion();
      }
    };

    const alCambiarVisibilidad = () => {
      if (estaVisible()) {
        refrescar("visibilidad");
        conectar();
      } else {
        controller?.abort();
      }
    };

    const alConectar = () => {
      intentos = 0;
      refrescar("online");
      conectar();
    };
    const alDesconectar = () => {
      statusRef.current?.("sin_conexion");
      controller?.abort();
    };

    const fallbackId = window.setInterval(() => refrescar("intervalo"), REFRESH_FALLBACK_MS);
    document.addEventListener("visibilitychange", alCambiarVisibilidad);
    window.addEventListener("online", alConectar);
    window.addEventListener("offline", alDesconectar);
    conectar();

    return () => {
      detenido = true;
      controller?.abort();
      if (reintentoId) window.clearTimeout(reintentoId);
      window.clearInterval(fallbackId);
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
      window.removeEventListener("online", alConectar);
      window.removeEventListener("offline", alDesconectar);
    };
  }, [apiKey]);
}
