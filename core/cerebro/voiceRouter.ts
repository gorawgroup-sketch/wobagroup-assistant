import { Router, type Request, type Response } from "express";
import { once } from "node:events";
import { MAX_VOICE_TEXT, sintetizarVoz, transmitirVozPcm, VOICE_SAMPLE_RATE, WOBI_VOICE } from "./voice";

export function crearRouterVoz(
  autorizar: (req: Request, res: Response) => Promise<boolean>,
  sintetizar = sintetizarVoz,
  timeoutMs = 20_000,
  transmitir = transmitirVozPcm,
) {
  const router = Router();
  const active = new Set<string>();
  router.post(["/", "/stream"], async (req, res) => {
    try {
      if (!await autorizar(req, res)) return;
    } catch {
      res.status(503).json({ error: "No se pudo verificar el acceso a la voz." });
      return;
    }
    const texto = req.body?.texto;
    if (typeof texto !== "string" || !texto.trim() || texto.length > MAX_VOICE_TEXT) {
      res.status(400).json({ error: "El fragmento de voz debe contener entre 1 y 500 caracteres." });
      return;
    }
    const key = req.get("X-Cerebro-Key") || "";
    if (active.size >= 4 || active.has(key)) {
      res.set("Retry-After", "2").status(429).json({ error: "La voz está ocupada. Inténtalo de nuevo." });
      return;
    }
    active.add(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onClose = () => controller.abort();
    res.on("close", onClose);
    try {
      if (req.path === "/stream") {
        await transmitir(texto.trim(), controller.signal, async audio => {
          controller.signal.throwIfAborted();
          if (!res.headersSent) {
            res.set("Cache-Control", "no-store").set("X-Wobi-Voice", WOBI_VOICE)
              .set("X-Audio-Format", "pcm-s16le").set("X-Audio-Sample-Rate", String(VOICE_SAMPLE_RATE))
              .set("X-Accel-Buffering", "no").type("application/octet-stream");
          }
          if (!res.write(audio)) await once(res, "drain", { signal: controller.signal });
        });
        if (!controller.signal.aborted) res.end();
        return;
      }
      const audio = await sintetizar(texto.trim(), controller.signal);
      if (!controller.signal.aborted) {
        res.set("Cache-Control", "no-store").set("X-Wobi-Voice", WOBI_VOICE).type("audio/mpeg").send(audio);
      }
    } catch {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) res.status(503).json({ error: "No se pudo preparar la voz. La respuesta sigue disponible por escrito." });
    } finally {
      clearTimeout(timer);
      res.removeListener("close", onClose);
      active.delete(key);
    }
  });
  return router;
}
