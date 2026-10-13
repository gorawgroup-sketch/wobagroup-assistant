import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { MANIFIESTO_RESTAURACION, restaurarComprobante, type DepsRestauracion, type EntradaRestauracion } from "./restaurarComprobantes";

/**
 * Acción de administración (ver restaurarComprobantes.ts):
 *   GET  /   estado de cada comprobante rescatado: cuántos adjuntos tiene hoy su compra en Holded (solo lectura).
 *   POST /   { purchaseId, intento? } → sube la copia rescatada SI la compra no tiene adjuntos; si no, la rechaza sin tocar nada.
 * Protegida por ADMIN_SECRET en la cabecera `x-admin-secret` (nunca en la URL). Recibe sus dependencias: no importa Holded ni Drive.
 */
export interface DepsRouterRestaurar {
  secreto(): string | undefined;
  deps: DepsRestauracion;
  /** Solo para pruebas. */
  manifiesto?: readonly EntradaRestauracion[];
}

const PURCHASE_ID = /^[a-f0-9]{24}$/;
const INTENTO = /^[A-Za-z0-9_-]{1,20}$/;

function secretoValido(recibido: string | undefined, esperado: string): boolean {
  const a = Buffer.from(recibido ?? ""), b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function crearRouterRestaurarComprobantes(d: DepsRouterRestaurar) {
  const router = Router();

  function autorizar(req: Request, res: Response): boolean {
    res.set("Cache-Control", "no-store");
    const esperado = d.secreto();
    if (!esperado) { res.status(503).json({ error: "ADMIN_SECRET no configurado en el servidor." }); return false; }
    if (!secretoValido(req.get("x-admin-secret"), esperado)) { res.status(403).json({ error: "Secreto de administración inválido o ausente." }); return false; }
    return true;
  }

  router.get("/", async (req, res) => {
    if (!autorizar(req, res)) return;
    const filas = [];
    for (const e of d.manifiesto ?? MANIFIESTO_RESTAURACION) {
      let adjuntos: number | null = null;
      try { adjuntos = await d.deps.contarAdjuntos(e.empresa, e.purchaseId); } catch { adjuntos = null; }
      filas.push({ purchaseId: e.purchaseId, etiqueta: e.etiqueta, adjuntos, estado: adjuntos === null ? "no_se_pudo_leer" : adjuntos === 0 ? "lista_para_restaurar" : "tiene_adjuntos" });
    }
    res.json({ comprobantes: filas });
  });

  router.post("/", async (req, res) => {
    if (!autorizar(req, res)) return;
    const cuerpo = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const purchaseId = cuerpo.purchaseId;
    if (typeof purchaseId !== "string" || !PURCHASE_ID.test(purchaseId)) { res.status(400).json({ error: "purchaseId inválido (24 caracteres hexadecimales)." }); return; }
    const intento = cuerpo.intento === undefined ? "1" : cuerpo.intento;
    if (typeof intento !== "string" || !INTENTO.test(intento)) { res.status(400).json({ error: "intento inválido." }); return; }
    try {
      const r = await restaurarComprobante(purchaseId, d.deps, intento, d.manifiesto);
      res.status(r.estado === "restaurado" ? 200 : r.motivo === "no_esta_en_el_manifiesto" ? 404 : 409).json(r);
    } catch (error) {
      console.error("[restaurarComprobantes] Fallo al restaurar:", error instanceof Error ? error.name : "Error");
      // Un fallo tras iniciar la subida puede haberla dejado hecha: no se reintenta solo; se consulta el estado (GET) antes de repetir.
      res.status(502).json({ error: "No se pudo completar la restauración. Comprueba el estado (GET) antes de reintentar: puede haberse subido ya.", purchaseId });
    }
  });

  return router;
}
