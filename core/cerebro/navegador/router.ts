import { createHash, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { CatalogoNavegacion } from "./catalogo";
import { conversar } from "./conversar";
import { crearAlmacenContexto, type AlmacenContexto } from "./contexto";
import { interpretarNavegacion, MAX_TEXTO_NAVEGACION, type RespuestaNavegacion } from "./interprete";
import type { SnapshotSeguros } from "./lecturas";
import { companiasAutorizadas, nivelDeIdentidad, nivelRequerido, tieneAcceso, type IdentidadNavegacion } from "./permisos";

/**
 * Navegación de WOBi, SOLO LECTURA:
 *   GET  /catalogo     catálogo versionado y autorizado para ESTA identidad.
 *   POST /interpretar  { texto | seleccion, companyId, requestId? } → destino | aclaracion | no_disponible.
 *   POST /conversar    { texto | seleccion, companyId, requestId?, conversacionId? } → lo mismo + conversacionId, resumen, modo y, en las vistas
 *                      de Seguros, una `lectura` con fecha, fuentes y estado. Determinista y sin coste (E1); mismo camino de permisos.
 *
 * Identidad y permisos se resuelven en el servidor (clave + dispositivo vinculado, como el chat). Del cuerpo solo se leen `texto`,
 * `seleccion`, `companyId` y `requestId`: cualquier otro campo (rol, permisos, capacidades, URLs, selectores) se ignora. Este router no
 * importa herramientas, chat, modelos ni escritores: no hay camino desde aquí a una acción.
 */
export interface DepsRouterNavegador {
  autorizar(req: Request, res: Response): Promise<boolean>;
  identidad(req: Request): Promise<IdentidadNavegacion | null>;
  catalogo(): Promise<CatalogoNavegacion>;
  nuevoRequestId?: () => string;
  ahora?: () => number;
  /** Lectura del estado de Seguros del panel (el mismo snapshot que ya se sirve en /estado). Ausente = las lecturas dicen «no consultable». */
  snapshotSeguros?: () => Promise<SnapshotSeguros>;
  /** Contexto de conversación en memoria; por defecto uno propio con caducidad de 10 minutos. */
  almacenContexto?: AlmacenContexto;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PETICIONES_POR_MINUTO = 40;

export function crearRouterNavegador(deps: DepsRouterNavegador) {
  const router = Router();
  const ahora = deps.ahora ?? Date.now;
  const nuevoRequestId = deps.nuevoRequestId ?? randomUUID;
  const ventanas = new Map<string, number[]>();
  const almacen = deps.almacenContexto ?? crearAlmacenContexto({ ahora });
  const claveDeContexto = (req: Request, identidad: IdentidadNavegacion): string =>
    createHash("sha256").update(`${identidad.chatId ?? ""}|${req.get("X-Cerebro-Device") ?? ""}`).digest("hex");

  /** Autentica, resuelve identidad y carga el catálogo; responde el error y devuelve null si algo falla. */
  async function contexto(req: Request, res: Response) {
    res.set("Cache-Control", "no-store");
    try {
      if (!await deps.autorizar(req, res)) return null;
    } catch {
      res.status(503).json({ error: "No se pudo verificar la sesión. Reintenta en unos segundos." });
      return null;
    }
    const clave = req.get("X-Cerebro-Key") ?? "";
    const t = ahora();
    const recientes = (ventanas.get(clave) ?? []).filter((x) => t - x < 60_000);
    if (recientes.length >= MAX_PETICIONES_POR_MINUTO) {
      res.set("Retry-After", "5").status(429).json({ error: "Demasiadas peticiones de navegación. Espera unos segundos." });
      return null;
    }
    recientes.push(t);
    ventanas.set(clave, recientes);
    let identidad: IdentidadNavegacion | null;
    try {
      identidad = await deps.identidad(req);
    } catch {
      res.status(503).json({ error: "WOBi está reconectando sus datos. Inténtalo de nuevo en unos segundos." });
      return null;
    }
    if (!identidad) { res.status(403).json({ error: "Sesión inválida o dispositivo no reconocido." }); return null; }
    let catalogo: CatalogoNavegacion;
    try {
      catalogo = await deps.catalogo();
    } catch (error) {
      console.error("[navegador] No se pudo cargar el catálogo de navegación:", error instanceof Error ? error.name : "Error");
      res.status(503).json({ error: "No se pudo cargar el catálogo de navegación. No se abre nada hasta poder validarlo." });
      return null;
    }
    return { identidad, nivel: nivelDeIdentidad(identidad), catalogo };
  }

  router.get("/catalogo", async (req, res) => {
    const c = await contexto(req, res);
    if (!c) return;
    const companias = companiasAutorizadas(c.identidad, c.catalogo.companias);
    res.json({
      version: c.catalogo.version,
      generadoEn: new Date(ahora()).toISOString(),
      companias,
      conversacional: { disponible: true, modo: "deterministico", lecturas: ["seguros_pagos_pendientes", "seguros_proximas_renovaciones", "seguros_actividad"] },
      capacidades: c.catalogo.capacidades.map((cap) => ({
        id: cap.id, label: cap.label, description: cap.description, status: cap.status, target: cap.target, ...(cap.scope ? { scope: cap.scope } : {}),
        companies: cap.companies.filter((x) => companias.includes(x)),
        acceso: tieneAcceso(c.nivel, cap.id) ? "permitido" : "permiso_insuficiente",
        nivelRequerido: nivelRequerido(cap.id).minimo,
      })),
    });
  });

  /** Valida el cuerpo común de /interpretar y /conversar; responde el 400 y devuelve null si algo no cuadra. Solo lee estos campos. */
  function leerPeticion(req: Request, res: Response, c: { identidad: IdentidadNavegacion; catalogo: CatalogoNavegacion }) {
    const cuerpo = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const companias = companiasAutorizadas(c.identidad, c.catalogo.companias);
    const companyId = cuerpo.companyId;
    if (typeof companyId !== "string" || !companias.includes(companyId)) {
      res.status(400).json({ error: "Elige una compañía válida." }); return null;
    }
    const requestId = cuerpo.requestId === undefined ? nuevoRequestId() : cuerpo.requestId;
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
      res.status(400).json({ error: "requestId inválido: entre 8 y 64 caracteres (letras, números, guion y guion bajo)." }); return null;
    }
    const sel = cuerpo.seleccion as Record<string, unknown> | undefined;
    let seleccion: { capabilityId: string; companyId: string } | undefined;
    if (sel !== undefined) {
      if (!sel || typeof sel !== "object" || typeof sel.capabilityId !== "string" || typeof sel.companyId !== "string" || !companias.includes(sel.companyId)) {
        res.status(400).json({ error: "La opción elegida no es válida." }); return null;
      }
      seleccion = { capabilityId: sel.capabilityId, companyId: sel.companyId };
    }
    const texto = cuerpo.texto;
    if (!seleccion && (typeof texto !== "string" || texto.trim().length === 0 || texto.length > MAX_TEXTO_NAVEGACION)) {
      res.status(400).json({ error: `Escribe entre 1 y ${MAX_TEXTO_NAVEGACION} caracteres.` }); return null;
    }
    return { companyId, requestId, seleccion, texto: typeof texto === "string" ? texto : undefined, conversacionId: cuerpo.conversacionId };
  }

  router.post("/interpretar", async (req, res) => {
    const c = await contexto(req, res);
    if (!c) return;
    const p = leerPeticion(req, res, c);
    if (!p) return;
    const respuesta: RespuestaNavegacion = interpretarNavegacion({
      texto: p.texto, seleccion: p.seleccion, companyId: p.companyId, nivel: c.nivel, catalogo: c.catalogo, requestId: p.requestId,
    });
    res.json(respuesta);
  });

  router.post("/conversar", async (req, res) => {
    const c = await contexto(req, res);
    if (!c) return;
    const p = leerPeticion(req, res, c);
    if (!p) return;
    try {
      res.json(await conversar({
        texto: p.texto, seleccion: p.seleccion, companyId: p.companyId, nivel: c.nivel, catalogo: c.catalogo, requestId: p.requestId,
        conversacionId: p.conversacionId, clave: claveDeContexto(req, c.identidad), almacen, snapshotSeguros: deps.snapshotSeguros, ahora,
      }));
    } catch (error) {
      console.error("[navegador] Fallo al conversar:", error instanceof Error ? error.name : "Error");
      res.status(503).json({ error: "No se pudo resolver la petición. Reinténtalo en unos segundos." });
    }
  });

  return router;
}
