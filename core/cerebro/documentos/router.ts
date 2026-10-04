import { Router, type Request, type Response } from "express";
import { searchDriveFiles } from "../../drive/client";
import { ROOT_FOLDERS } from "../../drive/rootFolders";

/** Read-only metadata search using the same roots and access as Cerebro/Drive tools. */
export function crearRouterDocumentos(
  autorizar: (req: Request, res: Response) => Promise<boolean>,
  buscar = searchDriveFiles,
  timeoutMs = 30_000,
) {
  const router = Router();
  const active = new Set<string>();
  router.get("/", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!await autorizar(req, res)) return;
    } catch {
      res.status(503).json({ error: "No se pudo verificar la sesión. Reintenta en unos segundos." }); return;
    }
    const empresa = req.query.empresa;
    const consulta = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (typeof empresa !== "string" || !Object.hasOwn(ROOT_FOLDERS, empresa) || consulta.length < 3 || consulta.length > 80 || consulta.split(/\s+/).length > 4) {
      res.status(400).json({ error: "Elige una compañía y escribe entre 3 y 80 caracteres (hasta cuatro palabras)." }); return;
    }
    const key = req.get("X-Cerebro-Key") || "";
    if (active.has(key) || active.size >= 2) {
      res.set("Retry-After", "5").status(429).json({ error: "Ya hay una búsqueda en curso. Espera unos segundos y vuelve a buscar." }); return;
    }
    active.add(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Keep capacity reserved until Drive actually settles, even if the browser leaves or we time out.
    const work = Promise.resolve().then(() => buscar(ROOT_FOLDERS[empresa], consulta)).finally(() => active.delete(key));
    try {
      const resultados = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timeout")), timeoutMs); })]);
      if (!res.destroyed) res.json({ empresa, consulta, consultadoEn: new Date().toISOString(), resultados });
    } catch {
      if (!res.destroyed) res.status(503).json({ error: "No se pudo completar la consulta a Drive. No se puede concluir que no existan documentos. Reintenta con un nombre más específico." });
    } finally { if (timer) clearTimeout(timer); }
  });
  return router;
}
