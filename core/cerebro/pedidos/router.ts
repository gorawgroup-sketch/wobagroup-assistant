import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { EntregaTelegramDurable } from "../../telegram/durableDelivery";
import type { TelegramUpdate } from "../../telegram/types";
import { crearAlmacenBorradores, type AlmacenBorradores, type Borrador } from "./borradores";
import {
  PEDIDO_ID, claveEntregaDePedido, construirUpdateDePedido, hashTextoPedido, huellaDispositivo, refDePedido, textoEcoPedido,
  validarTextoPedido, vistaDeEntrega, type VistaEstadoPedido,
} from "./pedido";

/**
 * «Pídele a WOBi» → el MISMO procesamiento que un mensaje de Telegram de esa persona, sin que copie y envíe nada a mano.
 *   GET  /disponibilidad          ¿puede esta sesión enviar pedidos? (y por qué no)
 *   POST /                        { texto, pedidoId? }       → BORRADOR (nada se envía)
 *   POST /:pedidoId/confirmar     { textoHash }              → recibido (202) · idempotente
 *   POST /:pedidoId/cancelar                                 → cancelado
 *   GET  /:pedidoId                                          → estado (recibido · procesando · terminado · fallido …)
 *
 * Identidad: la del servidor (`resolverIdentidadChatWeb`: clave + dispositivo vinculado a SU Telegram con un código que solo esa
 * persona puede confirmar desde su cuenta). Del cuerpo solo se leen `texto`, `pedidoId` y `textoHash`: nunca un usuario, un chat, un rol
 * ni una credencial. Sin vínculo verificado no se envía nada. Confirmar el envío NO aprueba ninguna operación: toda aprobación financiera
 * o sensible sigue siendo un botón de Telegram. Este módulo no importa Telegram, Holded, Claude ni escritores: recibe sus dependencias.
 */
export interface IdentidadPedidos {
  chatId: number;
  nombre: string;
  rol?: string;
  vinculadaTelegram: boolean;
  modo: "completo" | "solo_lectura";
}

export interface EventoBitacoraPedido {
  evento: "confirmado" | "cancelado" | "rechazado";
  pedidoId: string;
  ref: string;
  chatId: number;
  nombre: string;
  rol?: string;
  dispositivo: string;
  textoHash: string;
  longitud: number;
  detalle?: string;
}

export interface DepsRouterPedidos {
  autorizar(req: Request, res: Response): Promise<boolean>;
  identidad(req: Request): Promise<IdentidadPedidos | null>;
  /** Ledger durable de entregas de Telegram (el mismo que usa el webhook). */
  entregas: {
    reservar(update: TelegramUpdate): Promise<{ entrega: EntregaTelegramDurable; nueva: boolean }>;
    atender(entrega: EntregaTelegramDurable, nueva: boolean): Promise<void>;
    obtener(clave: string): Promise<EntregaTelegramDurable | undefined>;
  };
  /** Falso si el ledger durable está apagado por configuración: sin él no hay recepción verificable ni recuperación. */
  entregaDurableHabilitada: boolean;
  /** Eco del pedido en el chat de Telegram de la persona, para que la respuesta del bot tenga contexto. */
  eco(chatId: number, texto: string): Promise<void>;
  /** Registra una promesa en segundo plano para que el cierre ordenado del servidor la espere. */
  rastrear(promesa: Promise<unknown>): void;
  bitacora?(evento: EventoBitacoraPedido): Promise<void>;
  /** Interruptor de emergencia (`WOBI_PEDIDOS_FRONT=apagado`). */
  habilitado?: () => boolean;
  almacen?: AlmacenBorradores;
  ahora?: () => number;
  nuevoPedidoId?: () => string;
}

const MAX_CONFIRMACIONES_POR_MINUTO = 10;
const MAX_BORRADORES_POR_MINUTO = 20;
const MAX_CONSULTAS_POR_MINUTO = 60;
const CACHE_ESTADO_ACTIVO_MS = 2_000;
const CACHE_ESTADO_TERMINAL_MS = 10 * 60_000;

type Motivo = "apagado" | "entrega_durable_apagada" | "sin_vinculo";

/** Ventana deslizante por persona. Los reintentos de un mismo pedido no consumen plaza adicional. */
function crearLimitador(ahora: () => number, max: number) {
  const ventanas = new Map<string, Map<string, number>>();
  return (persona: number, id: string): boolean => {
    const t = ahora();
    const recientes = ventanas.get(String(persona)) ?? new Map<string, number>();
    for (const [k, momento] of recientes) if (t - momento >= 60_000) recientes.delete(k);
    if (recientes.has(id)) return true;
    if (recientes.size >= max) return false;
    recientes.set(id, t);
    ventanas.set(String(persona), recientes);
    if (ventanas.size > 5_000) for (const [k, v] of ventanas) if (v.size === 0) ventanas.delete(k);
    return true;
  };
}

export function crearRouterPedidos(deps: DepsRouterPedidos) {
  const router = Router();
  const ahora = deps.ahora ?? Date.now;
  const almacen = deps.almacen ?? crearAlmacenBorradores({ ahora });
  const nuevoPedidoId = deps.nuevoPedidoId ?? (() => randomBytes(16).toString("hex"));
  const limiteBorradores = crearLimitador(ahora, MAX_BORRADORES_POR_MINUTO);
  const limiteConfirmaciones = crearLimitador(ahora, MAX_CONFIRMACIONES_POR_MINUTO);
  const limiteConsultas = crearLimitador(ahora, MAX_CONSULTAS_POR_MINUTO);
  const cacheEstado = new Map<string, { vista: VistaEstadoPedido; hasta: number; actualizadoEn: number; creadoEn: number }>();
  let consultasSecuencia = 0;

  const motivoNoDisponible = (id: IdentidadPedidos): Motivo | undefined => {
    if (deps.habilitado && !deps.habilitado()) return "apagado";
    if (!deps.entregaDurableHabilitada) return "entrega_durable_apagada";
    if (id.modo !== "completo" || !id.vinculadaTelegram || !id.rol) return "sin_vinculo";
    return undefined;
  };
  const MENSAJE_MOTIVO: Record<Motivo, string> = {
    apagado: "Los pedidos desde el front están desactivados temporalmente.",
    entrega_durable_apagada: "Los pedidos desde el front necesitan el registro durable de Telegram, que está desactivado.",
    sin_vinculo: "Para enviar pedidos desde el front hay que vincular este dispositivo con tu Telegram autorizado. Genera el código de vinculación y escríbelo en tu chat de WOBi en Telegram.",
  };

  /** Autentica y resuelve la identidad; responde el error y devuelve null si algo falla. */
  async function sesion(req: Request, res: Response): Promise<IdentidadPedidos | null> {
    res.set("Cache-Control", "no-store");
    try {
      if (!await deps.autorizar(req, res)) return null;
    } catch {
      res.status(503).json({ error: "No se pudo verificar la sesión. Reintenta en unos segundos." });
      return null;
    }
    let id: IdentidadPedidos | null;
    try {
      id = await deps.identidad(req);
    } catch {
      res.status(503).json({ error: "WOBi está reconectando sus datos. Inténtalo de nuevo en unos segundos." });
      return null;
    }
    if (!id) { res.status(403).json({ error: "Sesión inválida o dispositivo no reconocido.", codigo: "sesion_invalida" }); return null; }
    return id;
  }

  /** Además de la sesión, exige poder enviar pedidos (vínculo verificado, ledger durable, interruptor). */
  async function sesionConVinculo(req: Request, res: Response): Promise<IdentidadPedidos | null> {
    const id = await sesion(req, res);
    if (!id) return null;
    const motivo = motivoNoDisponible(id);
    if (motivo) {
      res.status(motivo === "sin_vinculo" ? 403 : 503).json({ error: MENSAJE_MOTIVO[motivo], codigo: motivo });
      return null;
    }
    return id;
  }

  const dispositivoDe = (req: Request): string => huellaDispositivo(req.get("X-Cerebro-Device") ?? "");
  const registrar = async (id: IdentidadPedidos, req: Request, evento: EventoBitacoraPedido["evento"], pedidoId: string, texto: string, detalle?: string): Promise<void> => {
    try {
      await deps.bitacora?.({ evento, pedidoId, ref: refDePedido(id.chatId, pedidoId), chatId: id.chatId, nombre: id.nombre, rol: id.rol,
        dispositivo: dispositivoDe(req), textoHash: hashTextoPedido(texto), longitud: texto.length, ...(detalle ? { detalle } : {}) });
    } catch (error) {
      // La trazabilidad degradada no tumba el pedido, pero nunca pasa en silencio.
      console.error("[pedidos] No se pudo registrar la bitácora del pedido:", error instanceof Error ? error.name : "Error");
    }
  };

  async function estadoDeEntrega(chatId: number, pedidoId: string): Promise<{ vista: VistaEstadoPedido; creadoEn: number; actualizadoEn: number } | undefined> {
    const k = `${chatId}:${pedidoId}`;
    const t = ahora();
    const cacheado = cacheEstado.get(k);
    if (cacheado && cacheado.hasta > t) return cacheado;
    const entrega = await deps.entregas.obtener(claveEntregaDePedido(chatId, pedidoId));
    if (!entrega) return undefined;
    const vista = vistaDeEntrega(entrega);
    const terminal = vista.estado === "terminado" || vista.estado === "fallido";
    const nueva = { vista, hasta: t + (terminal ? CACHE_ESTADO_TERMINAL_MS : CACHE_ESTADO_ACTIVO_MS), creadoEn: entrega.creadoEn, actualizadoEn: entrega.actualizadoEn };
    if (cacheEstado.size > 2_000) cacheEstado.clear();
    cacheEstado.set(k, nueva);
    return nueva;
  }

  const cuerpoEstado = (id: IdentidadPedidos, pedidoId: string, v: VistaEstadoPedido, extra: Record<string, unknown> = {}) => ({
    pedidoId, ref: refDePedido(id.chatId, pedidoId), estado: v.estado, ejecucion: v.ejecucion, ...(v.detalle ? { detalle: v.detalle } : {}), mensaje: v.mensaje,
    resultado: { canal: "telegram", donde: `La respuesta llega a tu chat de Telegram con WOBi y queda en el historial del chat (GET /api/cerebro/chat), a continuación de «Pedido desde el front (ref. ${refDePedido(id.chatId, pedidoId)})».` },
    ...extra,
  });

  const vistaBorrador = (b: Borrador): VistaEstadoPedido => b.estado === "cancelado"
    ? { estado: "cancelado", ejecucion: "no_enviada", mensaje: "Cancelaste este pedido. No se envió nada." }
    : ahora() >= b.expiraEn
      ? { estado: "expirado", ejecucion: "no_enviada", mensaje: "El borrador caducó sin confirmarse. No se envió nada." }
      : { estado: "pendiente_confirmacion", ejecucion: "no_enviada", mensaje: "Revisa el texto y confírmalo para enviarlo a WOBi. Confirmar el envío no aprueba ninguna operación: las aprobaciones siguen siendo en Telegram." };

  router.get("/disponibilidad", async (req, res) => {
    const id = await sesion(req, res);
    if (!id) return;
    const motivo = motivoNoDisponible(id);
    res.json({ disponible: motivo === undefined, ...(motivo ? { motivo, mensaje: MENSAJE_MOTIVO[motivo] } : {}),
      destino: { canal: "telegram", cuenta: id.nombre }, caducidadBorradorSegundos: 600 });
  });

  router.post("/", async (req, res) => {
    const id = await sesionConVinculo(req, res);
    if (!id) return;
    const cuerpo = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const texto = cuerpo.texto;
    const valido = validarTextoPedido(texto);
    if (!valido.ok) {
      if (valido.codigo === "texto_no_permitido") await registrar(id, req, "rechazado", "sin-id", String(texto), valido.codigo);
      res.status(valido.codigo === "texto_no_permitido" ? 422 : 400).json({ error: valido.mensaje, codigo: valido.codigo });
      return;
    }
    const pedidoId = cuerpo.pedidoId === undefined ? nuevoPedidoId() : cuerpo.pedidoId;
    if (typeof pedidoId !== "string" || !PEDIDO_ID.test(pedidoId)) {
      res.status(400).json({ error: "pedidoId inválido: entre 16 y 64 caracteres (letras, números, guion y guion bajo).", codigo: "pedido_id_invalido" });
      return;
    }
    if (!limiteBorradores(id.chatId, pedidoId)) {
      res.set("Retry-After", "10").status(429).json({ error: "Demasiados pedidos seguidos. Espera un momento.", codigo: "demasiados_pedidos" });
      return;
    }
    const textoOriginal = texto as string;
    const r = almacen.crear({ chatId: id.chatId, pedidoId, dispositivo: dispositivoDe(req), texto: textoOriginal, textoHash: hashTextoPedido(textoOriginal) });
    if (r.tipo === "conflicto_texto") {
      res.status(409).json({ error: "Ese pedidoId ya se usó con un texto distinto. Usa un identificador nuevo.", codigo: "pedido_id_con_otro_texto" });
      return;
    }
    if (r.tipo === "demasiados_pendientes") {
      res.status(429).json({ error: "Tienes demasiados borradores sin confirmar. Confirma o cancela alguno.", codigo: "demasiados_borradores" });
      return;
    }
    const b = r.borrador;
    const v = vistaBorrador(b);
    res.status(r.tipo === "creado" ? 201 : 200).json(cuerpoEstado(id, pedidoId, v, {
      texto: b.texto, textoHash: b.textoHash, expiraEn: new Date(b.expiraEn).toISOString(), destino: { canal: "telegram", cuenta: id.nombre }, duplicada: r.tipo === "existente",
    }));
  });

  router.post("/:pedidoId/confirmar", async (req, res) => {
    const id = await sesionConVinculo(req, res);
    if (!id) return;
    const pedidoId = req.params.pedidoId ?? "";
    if (!PEDIDO_ID.test(pedidoId)) { res.status(400).json({ error: "pedidoId inválido.", codigo: "pedido_id_invalido" }); return; }
    if (!limiteConfirmaciones(id.chatId, pedidoId)) {
      res.set("Retry-After", "10").status(429).json({ error: "Demasiados pedidos seguidos. Espera un momento.", codigo: "demasiados_pedidos" });
      return;
    }
    const cuerpo = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    try {
      const b = almacen.obtener(id.chatId, pedidoId);
      if (!b) {
        // Reintento tras perder el borrador (reinicio, caducidad): si ya se envió, se devuelve su estado; si no, no hay nada que confirmar.
        const previo = await estadoDeEntrega(id.chatId, pedidoId);
        if (previo) { res.status(previo.vista.estado === "terminado" || previo.vista.estado === "fallido" ? 200 : 202).json(cuerpoEstado(id, pedidoId, previo.vista, { duplicada: true, recibidoEn: new Date(previo.creadoEn).toISOString(), actualizadoEn: new Date(previo.actualizadoEn).toISOString() })); return; }
        res.status(404).json({ error: "No encuentro ese borrador: caducó o el servidor se reinició. No se envió nada; vuelve a escribir el pedido.", codigo: "borrador_no_encontrado" });
        return;
      }
      if (b.estado === "cancelado") { res.status(409).json({ error: "Este pedido fue cancelado. No se envió nada.", codigo: "pedido_cancelado" }); return; }
      if (cuerpo.textoHash !== b.textoHash) {
        res.status(409).json({ error: "El texto confirmado no coincide con el que se mostró. No se envió nada; revisa el pedido y confírmalo de nuevo.", codigo: "texto_distinto" });
        return;
      }
      if (b.estado === "pendiente" && ahora() >= b.expiraEn) { res.status(410).json({ error: "El borrador caducó sin confirmarse. No se envió nada.", codigo: "borrador_caducado" }); return; }

      // Recepción durable: la reserva en el ledger es lo que convierte el pedido en «recibido». Es idempotente por (persona, pedido):
      // doble clic, reintento o fallo de red devuelven la misma entrega y jamás una segunda ejecución.
      const update = construirUpdateDePedido({ chatId: id.chatId, nombre: id.nombre, texto: b.texto, pedidoId, dispositivo: b.dispositivo, ahoraMs: ahora() });
      let reserva: { entrega: EntregaTelegramDurable; nueva: boolean };
      try {
        reserva = await deps.entregas.reservar(update);
      } catch {
        res.status(503).json({ error: "No pude dejar registrado el pedido, así que no se envió nada. Puedes reintentar la confirmación sin riesgo de duplicarlo.", codigo: "recepcion_fallida" });
        return;
      }
      almacen.confirmar(id.chatId, pedidoId);
      if (!reserva.nueva) {
        const v = vistaDeEntrega(reserva.entrega);
        res.status(v.estado === "terminado" || v.estado === "fallido" ? 200 : 202).json(cuerpoEstado(id, pedidoId, v, { duplicada: true, recibidoEn: new Date(reserva.entrega.creadoEn).toISOString() }));
        return;
      }
      await registrar(id, req, "confirmado", pedidoId, b.texto);
      const v = vistaDeEntrega(reserva.entrega);
      res.status(202).json(cuerpoEstado(id, pedidoId, v, { duplicada: false, recibidoEn: new Date(reserva.entrega.creadoEn).toISOString() }));

      // El procesamiento sigue fuera del ciclo HTTP, exactamente como un mensaje de Telegram tras su 200.
      deps.rastrear((async () => {
        try {
          await deps.eco(id.chatId, textoEcoPedido(refDePedido(id.chatId, pedidoId), b.texto));
        } catch (error) {
          console.error("[pedidos] No se pudo enviar el eco del pedido a Telegram:", error instanceof Error ? error.name : "Error");
        }
        try {
          await deps.entregas.atender(reserva.entrega, true);
        } catch (error) {
          console.error("[pedidos] Error atendiendo el pedido:", error instanceof Error ? error.name : "Error");
        }
      })());
    } catch (error) {
      console.error("[pedidos] Error confirmando el pedido:", error instanceof Error ? error.name : "Error");
      if (!res.headersSent) res.status(500).json({ error: "No pude confirmar el pedido. No se envió nada; puedes reintentar.", codigo: "error_interno" });
    }
  });

  router.post("/:pedidoId/cancelar", async (req, res) => {
    const id = await sesionConVinculo(req, res);
    if (!id) return;
    const pedidoId = req.params.pedidoId ?? "";
    if (!PEDIDO_ID.test(pedidoId)) { res.status(400).json({ error: "pedidoId inválido.", codigo: "pedido_id_invalido" }); return; }
    const b = almacen.obtener(id.chatId, pedidoId);
    if (b?.estado === "cancelado") { res.json(cuerpoEstado(id, pedidoId, vistaBorrador(b), { duplicada: true })); return; }
    const cancelado = b ? almacen.cancelar(id.chatId, pedidoId) : undefined;
    if (!cancelado) {
      const enviado = (b && b.estado === "confirmado") || await estadoDeEntrega(id.chatId, pedidoId);
      res.status(enviado ? 409 : 404).json(enviado
        ? { error: "Este pedido ya se envió a WOBi y no se puede cancelar desde aquí.", codigo: "ya_enviado" }
        : { error: "No encuentro ese borrador.", codigo: "borrador_no_encontrado" });
      return;
    }
    await registrar(id, req, "cancelado", pedidoId, cancelado.texto);
    res.json(cuerpoEstado(id, pedidoId, vistaBorrador(cancelado), { duplicada: false }));
  });

  router.get("/:pedidoId", async (req, res) => {
    const id = await sesion(req, res);
    if (!id) return;
    const pedidoId = req.params.pedidoId ?? "";
    if (!PEDIDO_ID.test(pedidoId)) { res.status(400).json({ error: "pedidoId inválido.", codigo: "pedido_id_invalido" }); return; }
    if (!limiteConsultas(id.chatId, `${pedidoId}:${consultasSecuencia++}`)) {
      res.set("Retry-After", "5").status(429).json({ error: "Demasiadas consultas. Espera unos segundos.", codigo: "demasiadas_consultas" });
      return;
    }
    try {
      const enviado = await estadoDeEntrega(id.chatId, pedidoId);
      if (enviado) {
        res.json(cuerpoEstado(id, pedidoId, enviado.vista, { recibidoEn: new Date(enviado.creadoEn).toISOString(), actualizadoEn: new Date(enviado.actualizadoEn).toISOString() }));
        return;
      }
      const b = almacen.obtener(id.chatId, pedidoId);
      if (b) {
        const v = vistaBorrador(b);
        res.json(cuerpoEstado(id, pedidoId, v, v.estado === "pendiente_confirmacion"
          ? { texto: b.texto, textoHash: b.textoHash, expiraEn: new Date(b.expiraEn).toISOString() } : {}));
        return;
      }
      res.status(404).json({ error: "No encuentro ese pedido en tu cuenta.", codigo: "pedido_no_encontrado" });
    } catch (error) {
      console.error("[pedidos] Error consultando el pedido:", error instanceof Error ? error.name : "Error");
      res.status(503).json({ error: "No pude consultar el estado ahora. Reintenta en unos segundos.", codigo: "consulta_fallida" });
    }
  });

  return router;
}
