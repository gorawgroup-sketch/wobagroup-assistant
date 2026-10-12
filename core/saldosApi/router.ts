import { Router, Request, Response } from "express";
import { registrarSaldo, validarObservacion, obtenerSaldosApi } from "./index";
export function crearRouterSaldos(autorizar: (req: Request, res: Response) => boolean, actualizar: () => void) {
  const router = Router();
  router.get("/", async (req, res) => {
    if (!autorizar(req, res)) return;
    res.set("Cache-Control", "no-store").json({ saldos: await obtenerSaldosApi() });
  });
  router.post("/", async (req, res) => {
    if (!autorizar(req, res)) return;
    let observacion;
    try { observacion = validarObservacion(req.body); } catch { res.status(400).json({ error: "Introduce un saldo USD, umbral positivo y fecha de verificación válida." }); return; }
    try { await registrarSaldo(observacion); actualizar(); res.json({ ok: true }); }
    catch { res.status(503).json({ error: "No se pudo guardar la lectura. Reintenta; no se confirmó ningún cambio." }); }
  });
  return router;
}
