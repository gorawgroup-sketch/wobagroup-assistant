import { timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { executeTool } from "./registry";

/**
 * Acciones de administración que SOLO PROPONEN: ejecutan en el servidor (con sus credenciales, sus candados y su almacén) la misma herramienta que
 * usaría el chat, pero únicamente de una lista cerrada de herramientas que no escriben en Holded: cada una deja un mensaje con botones en el chat
 * del superadministrador y la escritura la hace SU botón. Sirve para que quien opera el sistema resuelva un caso sin pedirle a Carlos que escriba
 * comandos y sin ejecutar flujos de archivos desde un equipo local (la propuesta debe nacer en el servidor, donde viven los archivos y los botones).
 *
 *   POST /  { tool, input }   con la cabecera `x-admin-secret`.
 */
export const HERRAMIENTAS_PERMITIDAS: ReadonlySet<string> = new Set([
  "revisar_correo_puntual",
  "proponer_edicion_compra_holded",
  "reenviar_botones_propuesta_gasto",
  // Solo muestra el resumen del aviso de formato de soportes con sus botones; el correo lo envía el botón «Enviar» (superadmin).
  "preparar_aviso_formato_soportes",
]);

function secretoValido(recibido: string | undefined, esperado: string): boolean {
  const a = Buffer.from(recibido ?? ""), b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DepsProponerAccion {
  secreto(): string | undefined;
  /** Solo para pruebas. */
  chatSuperadmin?: () => Promise<number | undefined>;
  ejecutar?: (tool: string, input: Record<string, unknown>, chatId: number) => Promise<string>;
}

export function crearRouterProponerAccion(d: DepsProponerAccion) {
  const router = Router();
  router.post("/", express.json(), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const esperado = d.secreto();
    if (!esperado) { res.status(503).json({ error: "ADMIN_SECRET no configurado en el servidor." }); return; }
    if (!secretoValido(req.get("x-admin-secret"), esperado)) { res.status(403).json({ error: "Secreto de administración inválido o ausente." }); return; }
    const { tool, input } = (req.body ?? {}) as { tool?: unknown; input?: unknown };
    if (typeof tool !== "string" || !HERRAMIENTAS_PERMITIDAS.has(tool)) { res.status(400).json({ error: "Herramienta no permitida: solo las que proponen con botones." }); return; }
    if (!input || typeof input !== "object" || Array.isArray(input)) { res.status(400).json({ error: "Falta 'input' (objeto)." }); return; }
    try {
      const chatId = await (d.chatSuperadmin ?? chatDelSuperadmin)();
      if (!chatId) { res.status(409).json({ error: "No hay un superadministrador al que mandar la propuesta." }); return; }
      const resultado = await (d.ejecutar ?? ((t, i, c) => executeTool(t, i, { chatId: c })))(tool, input as Record<string, unknown>, chatId);
      res.json({ tool, resultado });
    } catch (error) {
      console.error("[admin/proponer-accion] Error:", error instanceof Error ? error.name : "Error");
      res.status(500).json({ error: "No se pudo preparar la propuesta." });
    }
  });
  return router;
}

async function chatDelSuperadmin(): Promise<number | undefined> {
  return (await obtenerAdmins()).find((a) => a.rol === "superadmin")?.userId;
}
