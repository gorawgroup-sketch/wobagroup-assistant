import assert from "node:assert/strict";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { CoordinadorEntregasTelegram, type EntregaTelegramDurable, type RepositorioEntregasTelegram } from "../../telegram/durableDelivery";
import type { TelegramUpdate } from "../../telegram/types";
import { crearAlmacenBorradores, MAX_BORRADORES_PENDIENTES_POR_CHAT, TTL_BORRADOR_MS } from "./borradores";
import {
  claveEntregaDePedido, construirUpdateDePedido, hashTextoPedido, huellaDispositivo, MAX_ECO, refDePedido, textoEcoPedido, updateIdDePedido,
  validarTextoPedido, vistaDeEntrega,
} from "./pedido";
import { crearRouterPedidos, type DepsRouterPedidos, type EventoBitacoraPedido, type IdentidadPedidos } from "./router";

/**
 * Pedidos desde «Pídele a WOBi»: identidad y permisos, confirmación, anti-duplicados y fallos. Se prueban con el coordinador DURABLE REAL
 * de Telegram (con un repositorio en memoria) y un procesador espía: lo que llega al procesador es lo que llegaría al flujo de Telegram.
 */

class RepoMemoria implements RepositorioEntregasTelegram {
  filas = new Map<string, EntregaTelegramDurable>();
  fallarReservas = 0;
  async reservar(entrega: EntregaTelegramDurable) {
    if (this.fallarReservas > 0) { this.fallarReservas--; throw new Error("Sheets caído"); }
    const existente = this.filas.get(entrega.clave);
    if (existente) return { entrega: { ...existente }, nueva: false };
    this.filas.set(entrega.clave, { ...entrega });
    return { entrega: { ...entrega }, nueva: true };
  }
  async reabrirCompletada() { return undefined; }
  async obtener(clave: string) { const e = this.filas.get(clave); return e ? { ...e } : undefined; }
  async marcarIniciada(clave: string) { return this.cambiar(clave, ["reservada"], "iniciada", false); }
  async marcarCompletada(clave: string) { this.cambiar(clave, ["iniciada"], "completada", true); }
  async marcarIncierta(clave: string) { return this.cambiar(clave, ["reservada", "iniciada"], "incierta", false); }
  async marcarNotificada(clave: string) { const a = this.filas.get(clave); if (a?.estado === "incierta") this.filas.set(clave, { ...a, notificadoEn: 1 }); }
  async listarRecuperables() { return [...this.filas.values()].filter((e) => e.estado !== "completada" && !e.notificadoEn); }
  private cambiar(clave: string, permitidos: EntregaTelegramDurable["estado"][], estado: EntregaTelegramDurable["estado"], limpiar: boolean) {
    const a = this.filas.get(clave);
    if (!a || !permitidos.includes(a.estado)) return undefined;
    const s = { ...a, estado, payload: limpiar ? "" : a.payload, actualizadoEn: Date.now() };
    this.filas.set(clave, s);
    return { ...s };
  }
}

const PERSONA_A: IdentidadPedidos = { chatId: 1001, nombre: "Ana", rol: "admin", vinculadaTelegram: true, modo: "completo" };
const PERSONA_B: IdentidadPedidos = { chatId: 2002, nombre: "Beto", rol: "colaborador", vinculadaTelegram: true, modo: "completo" };
const SIN_VINCULO: IdentidadPedidos = { chatId: -77, nombre: "Visita", vinculadaTelegram: false, modo: "solo_lectura" };
const IDENTIDADES: Record<string, IdentidadPedidos | null> = { a: PERSONA_A, b: PERSONA_B, visita: SIN_VINCULO, ninguna: null,
  sinrol: { chatId: 3003, nombre: "Sin rol", vinculadaTelegram: true, modo: "completo" } };

interface Entorno {
  url: string; repo: RepoMemoria; procesados: TelegramUpdate[]; ecos: Array<{ chatId: number; texto: string }>; bitacora: EventoBitacoraPedido[];
  avisosIncierta: EntregaTelegramDurable[]; consultas: { obtener: number }; terminado(): Promise<void>;
}

async function conEntorno(opciones: { procesar?: (u: TelegramUpdate) => Promise<void>; deps?: Partial<DepsRouterPedidos>; ahora?: () => number }, escenario: (e: Entorno) => Promise<void>) {
  const repo = new RepoMemoria();
  const procesados: TelegramUpdate[] = [];
  const ecos: Array<{ chatId: number; texto: string }> = [];
  const bitacora: EventoBitacoraPedido[] = [];
  const avisosIncierta: EntregaTelegramDurable[] = [];
  const consultas = { obtener: 0 };
  const pendientes: Promise<unknown>[] = [];
  const coordinador = new CoordinadorEntregasTelegram(repo, async (u) => { procesados.push(u); await (opciones.procesar?.(u)); }, async (e) => { avisosIncierta.push(e); });
  const app = express(); app.use(express.json());
  app.use("/pedidos", crearRouterPedidos({
    autorizar: async (req, res) => { if (req.get("X-Cerebro-Key") === "clave") return true; res.sendStatus(403); return false; },
    identidad: async (req) => IDENTIDADES[req.get("X-Persona") ?? "a"] ?? null,
    entregas: {
      reservar: (u) => coordinador.reservar(u, false),
      atender: (e, n) => coordinador.atender(e, n),
      obtener: (clave) => { consultas.obtener++; return repo.obtener(clave); },
    },
    entregaDurableHabilitada: true,
    eco: async (chatId, texto) => { ecos.push({ chatId, texto }); },
    rastrear: (p) => { pendientes.push(p.catch(() => undefined)); },
    bitacora: async (e) => { bitacora.push(e); },
    ahora: opciones.ahora,
    ...opciones.deps,
  }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const dir = server.address(); assert.ok(dir && typeof dir !== "string");
  try {
    await escenario({ url: `http://127.0.0.1:${dir.port}/pedidos`, repo, procesados, ecos, bitacora, avisosIncierta, consultas, terminado: async () => { await Promise.all(pendientes); } });
  } finally { server.closeAllConnections(); server.close(); }
}

const cab = (persona = "a", extra: Record<string, string> = {}) => ({ "X-Cerebro-Key": "clave", "Content-Type": "application/json", "X-Cerebro-Device": "dispositivo-secreto-aaaaaaaa", "X-Persona": persona, ...extra });
const ID1 = "pedido-aaaaaaaaaaaaaaaa";
const post = (url: string, ruta: string, cuerpo: unknown, persona = "a") => fetch(`${url}${ruta}`, { method: "POST", headers: cab(persona), body: JSON.stringify(cuerpo) });
const get = (url: string, ruta: string, persona = "a") => fetch(`${url}${ruta}`, { headers: cab(persona) });
type Cuerpo = Record<string, unknown> & { estado?: string; ejecucion?: string; detalle?: string; codigo?: string; duplicada?: boolean; textoHash?: string; texto?: string; mensaje?: string; pedidoId?: string; ref?: string };
const json = async (r: Response) => await r.json() as Cuerpo;

async function enviar(e: Entorno, texto: string, pedidoId = ID1, persona = "a") {
  const b = await json(await post(e.url, "", { texto, pedidoId }, persona));
  assert.equal(b.estado, "pendiente_confirmacion");
  return post(e.url, `/${pedidoId}/confirmar`, { textoHash: b.textoHash }, persona);
}

/* ───────── funciones puras ───────── */

test("identificadores: update_id NEGATIVO (nunca choca con uno de Telegram), determinista y distinto por persona y por pedido", () => {
  const a = updateIdDePedido(1001, ID1);
  assert.ok(a < 0 && Number.isSafeInteger(a));
  assert.equal(a, updateIdDePedido(1001, ID1));
  assert.notEqual(a, updateIdDePedido(2002, ID1), "el mismo pedidoId de otra persona es otro pedido");
  assert.notEqual(a, updateIdDePedido(1001, "pedido-bbbbbbbbbbbbbbbb"));
  assert.notEqual(claveEntregaDePedido(1001, ID1), claveEntregaDePedido(2002, ID1));
  assert.equal(refDePedido(1001, ID1).length, 8);
  assert.notEqual(refDePedido(1001, ID1), refDePedido(2002, ID1));
});

test("el update sintético lleva la identidad del servidor (usuario = chat), el texto verbatim y la marca de origen; nunca el dispositivo real", () => {
  const texto = "  Revisa el cobro de Uber\nde ayer  ";
  const u = construirUpdateDePedido({ chatId: 1001, nombre: "Ana", texto, pedidoId: ID1, dispositivo: huellaDispositivo("dispositivo-secreto-aaaaaaaa"), ahoraMs: 1_700_000_000_000 });
  assert.equal(u.message?.from?.id, 1001); assert.equal(u.message?.chat.id, 1001); assert.equal(u.message?.chat.type, "private"); assert.equal(u.message?.from?.is_bot, false);
  assert.equal(u.message?.text, texto, "ni recortes ni normalización");
  assert.equal(u.callback_query, undefined);
  assert.deepEqual(u.origen, { canal: "front", pedidoId: ID1, ref: refDePedido(1001, ID1), dispositivo: huellaDispositivo("dispositivo-secreto-aaaaaaaa"), textoHash: hashTextoPedido(texto) });
  assert.doesNotMatch(JSON.stringify(u), /dispositivo-secreto/);
});

test("texto del pedido: longitud, caracteres de control y, sobre todo, nunca un código de vinculación", () => {
  assert.equal(validarTextoPedido("¿Cuánto hemos gastado en Uber este mes?").ok, true);
  assert.equal(validarTextoPedido("línea 1\nlínea 2\tcon tabulador").ok, true);
  for (const malo of ["", "   ", 12, null, undefined, "a".repeat(4_001), "hola\u0000mundo"]) {
    const r = validarTextoPedido(malo); assert.equal(r.ok, false, String(malo)); assert.equal(!r.ok && r.codigo, "texto_invalido");
  }
  assert.equal(validarTextoPedido("a".repeat(4_000)).ok, true);
  for (const vinculo of ["vincular ABC123", "/vincular ABC-123", "  /Vincular abc123  ", "/start vincular_ABC123", "/start link-ABC123", "/start", "/start@wobi_bot link_ABC123"]) {
    const r = validarTextoPedido(vinculo); assert.equal(r.ok, false, vinculo); assert.equal(!r.ok && r.codigo, "texto_no_permitido", vinculo);
  }
});

test("estados: recibido y procesando NO son terminado; terminado no dice «aprobado»; una caída es fallido con resultado incierto", () => {
  assert.deepEqual([vistaDeEntrega({ estado: "reservada" }).estado, vistaDeEntrega({ estado: "reservada" }).ejecucion], ["recibido", "pendiente"]);
  assert.deepEqual([vistaDeEntrega({ estado: "iniciada" }).estado, vistaDeEntrega({ estado: "iniciada" }).ejecucion], ["procesando", "en_curso"]);
  const t = vistaDeEntrega({ estado: "completada" });
  assert.deepEqual([t.estado, t.ejecucion], ["terminado", "finalizada"]); assert.match(t.mensaje, /no significa que una operación se haya aprobado/);
  const f = vistaDeEntrega({ estado: "incierta" });
  assert.deepEqual([f.estado, f.ejecucion, f.detalle], ["fallido", "incierta", "resultado_incierto"]); assert.match(f.mensaje, /No se repite solo/);
});

test("el eco de Telegram lleva la referencia y se recorta, sin tocar el texto que se procesa", () => {
  const eco = textoEcoPedido("AB12CD34", "x".repeat(1_000));
  assert.match(eco, /ref\. AB12CD34/); assert.ok(eco.length < MAX_ECO + 80);
  assert.equal(textoEcoPedido("AB12CD34", "hola"), "📲 Pedido desde el front (ref. AB12CD34): «hola»");
});

test("borradores: idempotentes por (persona, pedido), aislados entre personas, con tope y caducidad", () => {
  let t = 1_000_000;
  const a = crearAlmacenBorradores({ ahora: () => t });
  const base = { chatId: 1, pedidoId: ID1, dispositivo: "d", texto: "uno", textoHash: hashTextoPedido("uno") };
  assert.equal(a.crear(base).tipo, "creado");
  assert.equal(a.crear(base).tipo, "existente");
  assert.equal(a.crear({ ...base, texto: "dos", textoHash: hashTextoPedido("dos") }).tipo, "conflicto_texto");
  assert.equal(a.crear({ ...base, chatId: 2 }).tipo, "creado", "otra persona con el mismo pedidoId");
  assert.equal(a.obtener(2, ID1)?.chatId, 2); assert.equal(a.obtener(3, ID1), undefined);
  for (let i = 0; i < MAX_BORRADORES_PENDIENTES_POR_CHAT; i++) a.crear({ ...base, chatId: 9, pedidoId: `relleno-${String(i).padStart(10, "0")}xxxx` });
  assert.equal(a.crear({ ...base, chatId: 9, pedidoId: "uno-de-mas-0000000000" }).tipo, "demasiados_pendientes");
  assert.ok(a.confirmar(1, ID1)); assert.equal(a.confirmar(1, ID1), undefined, "solo se confirma desde pendiente");
  assert.equal(a.cancelar(1, ID1), undefined, "lo confirmado no se cancela");
  t += TTL_BORRADOR_MS;
  assert.equal(a.obtener(2, ID1)?.estado, "pendiente", "el vencido sigue consultable (para decir «expirado»)");
  assert.equal(a.confirmar(2, ID1), undefined, "pero ya no se puede confirmar"); assert.equal(a.cancelar(2, ID1), undefined);
  assert.equal(a.crear({ ...base, chatId: 2, texto: "otro texto", textoHash: hashTextoPedido("otro texto") }).tipo, "creado", "pedir de nuevo con ese id abre un borrador nuevo");
  assert.equal(a.obtener(1, ID1)?.estado, "confirmado", "lo confirmado se recuerda para detectar el doble envío");
  t += 24 * 60 * 60_000;
  assert.equal(a.obtener(1, ID1), undefined, "y pasado un día se olvida");
});

/* ───────── permisos e identidad ───────── */

test("PERMISOS: sin sesión, sin identidad reconocida, sin vínculo con Telegram o sin rol autorizado no se envía nada", async () => {
  await conEntorno({}, async (e) => {
    assert.equal((await fetch(`${e.url}/disponibilidad`)).status, 403);
    assert.equal((await post(e.url, "", { texto: "hola" }, "ninguna")).status, 403);
    for (const persona of ["visita", "sinrol"]) {
      for (const [ruta, cuerpo] of [["", { texto: "hola" }], [`/${ID1}/confirmar`, { textoHash: "x" }], [`/${ID1}/cancelar`, {}]] as const) {
        const r = await post(e.url, ruta, cuerpo, persona);
        assert.equal(r.status, 403, `${persona} ${ruta}`); assert.equal((await json(r)).codigo, "sin_vinculo");
      }
      const d = await json(await get(e.url, "/disponibilidad", persona));
      assert.equal(d.disponible, false); assert.equal(d.motivo, "sin_vinculo"); assert.match(String(d.mensaje), /vincular este dispositivo con tu Telegram/);
    }
    assert.equal(e.procesados.length, 0); assert.equal(e.ecos.length, 0);
    const ok = await json(await get(e.url, "/disponibilidad", "a"));
    assert.equal(ok.disponible, true); assert.deepEqual(ok.destino, { canal: "telegram", cuenta: "Ana" });
  });
});

test("PERMISOS: interruptor de emergencia y ledger durable apagado cierran el envío, con motivo", async () => {
  await conEntorno({ deps: { habilitado: () => false } }, async (e) => {
    const r = await post(e.url, "", { texto: "hola" }); assert.equal(r.status, 503); assert.equal((await json(r)).codigo, "apagado");
    assert.equal((await json(await get(e.url, "/disponibilidad"))).motivo, "apagado");
  });
  await conEntorno({ deps: { entregaDurableHabilitada: false } }, async (e) => {
    const r = await post(e.url, "", { texto: "hola" }); assert.equal(r.status, 503); assert.equal((await json(r)).codigo, "entrega_durable_apagada");
  });
});

test("PERMISOS: el usuario, el chat y el rol los pone el servidor; lo que mande el cliente se ignora, y el dispositivo real no sale de aquí", async () => {
  await conEntorno({}, async (e) => {
    const b = await json(await post(e.url, "", { texto: "Pídele a WOBi el saldo", pedidoId: ID1, chatId: 2002, userId: 2002, from: { id: 2002 }, rol: "superadmin", nombre: "Beto", modo: "completo" }));
    await post(e.url, `/${ID1}/confirmar`, { textoHash: b.textoHash, chatId: 2002, from: { id: 2002 }, rol: "superadmin" });
    await e.terminado();
    assert.equal(e.procesados.length, 1);
    const m = e.procesados[0].message!;
    assert.equal(m.from?.id, 1001); assert.equal(m.chat.id, 1001); assert.equal(m.from?.first_name, "Ana");
    assert.deepEqual(e.ecos.map((x) => x.chatId), [1001]);
    assert.equal(e.bitacora[0].chatId, 1001); assert.equal(e.bitacora[0].rol, "admin");
    assert.doesNotMatch(JSON.stringify([e.procesados, e.bitacora, e.ecos]), /dispositivo-secreto/);
    assert.equal(e.bitacora[0].dispositivo, huellaDispositivo("dispositivo-secreto-aaaaaaaa"));
  });
});

test("PERMISOS: un código de vinculación como pedido se rechaza y se deja constancia; no llega al flujo de Telegram", async () => {
  await conEntorno({}, async (e) => {
    const r = await post(e.url, "", { texto: "/vincular ABC123", pedidoId: ID1 });
    assert.equal(r.status, 422); assert.equal((await json(r)).codigo, "texto_no_permitido");
    assert.deepEqual(e.bitacora.map((x) => [x.evento, x.detalle]), [["rechazado", "texto_no_permitido"]]);
    assert.equal(e.procesados.length, 0);
    assert.equal((await post(e.url, `/${ID1}/confirmar`, { textoHash: hashTextoPedido("/vincular ABC123") })).status, 404, "tampoco se puede confirmar sin borrador");
  });
});

/* ───────── confirmación y flujo ───────── */

test("FLUJO: el borrador no envía nada; al confirmar queda recibido (202) y se procesa como un mensaje de Telegram; luego terminado", async () => {
  await conEntorno({}, async (e) => {
    const texto = "  ¿Cuánto debe eWorks a Uber?\n(solo lectura)  ";
    const b = await post(e.url, "", { texto, pedidoId: ID1 });
    assert.equal(b.status, 201); assert.equal(b.headers.get("Cache-Control"), "no-store");
    const borrador = await json(b);
    assert.equal(borrador.estado, "pendiente_confirmacion"); assert.equal(borrador.ejecucion, "no_enviada"); assert.equal(borrador.texto, texto, "texto original conservado");
    assert.equal(borrador.textoHash, hashTextoPedido(texto)); assert.match(String(borrador.mensaje), /no aprueba ninguna operación/);
    assert.equal(e.procesados.length, 0); assert.equal(e.repo.filas.size, 0, "nada en el ledger hasta confirmar");

    const c = await post(e.url, `/${ID1}/confirmar`, { textoHash: borrador.textoHash });
    assert.equal(c.status, 202);
    const rec = await json(c);
    assert.equal(rec.estado, "recibido"); assert.equal(rec.ejecucion, "pendiente"); assert.equal(rec.duplicada, false); assert.equal(rec.ref, refDePedido(1001, ID1));
    await e.terminado();

    assert.equal(e.procesados.length, 1);
    const u = e.procesados[0];
    assert.equal(u.message?.text, texto); assert.ok(u.update_id < 0); assert.equal(u.origen?.canal, "front");
    assert.deepEqual(e.ecos, [{ chatId: 1001, texto: textoEcoPedido(refDePedido(1001, ID1), texto) }]);
    assert.deepEqual(e.bitacora.map((x) => [x.evento, x.pedidoId, x.textoHash, x.longitud]), [["confirmado", ID1, hashTextoPedido(texto), texto.length]]);

    const fin = await json(await get(e.url, `/${ID1}`));
    assert.equal(fin.estado, "terminado"); assert.equal(fin.ejecucion, "finalizada"); assert.match(String(fin.mensaje), /no significa que una operación se haya aprobado/);
    assert.match(JSON.stringify(fin.resultado), /Telegram/);
  });
});

test("FLUJO: mientras procesa se ve «procesando» (distinto de recibido y de terminado)", async () => {
  let liberar!: () => void;
  const espera = new Promise<void>((r) => { liberar = r; });
  await conEntorno({ procesar: () => espera }, async (e) => {
    const c = await enviar(e, "una consulta larga");
    assert.equal(c.status, 202);
    await new Promise((r) => setTimeout(r, 25));
    const durante = await json(await get(e.url, `/${ID1}`));
    assert.equal(durante.estado, "procesando"); assert.equal(durante.ejecucion, "en_curso");
    liberar(); await e.terminado();
    await new Promise((r) => setTimeout(r, 2_100)); // caduca la caché de estado activo
    assert.equal((await json(await get(e.url, `/${ID1}`))).estado, "terminado");
  });
});

test("CONFIRMACIÓN: el hash debe ser el del texto mostrado; si no coincide o falta, no se envía nada", async () => {
  await conEntorno({}, async (e) => {
    await post(e.url, "", { texto: "pedido original", pedidoId: ID1 });
    for (const cuerpo of [{ textoHash: hashTextoPedido("pedido modificado") }, {}, { textoHash: 7 }]) {
      const r = await post(e.url, `/${ID1}/confirmar`, cuerpo);
      assert.equal(r.status, 409, JSON.stringify(cuerpo)); assert.equal((await json(r)).codigo, "texto_distinto");
    }
    assert.equal(e.procesados.length, 0); assert.equal(e.repo.filas.size, 0);
    assert.equal((await post(e.url, "", { texto: "otro texto", pedidoId: ID1 })).status, 409, "el mismo pedidoId no puede cambiar de texto");
  });
});

test("CONFIRMACIÓN: cancelar impide el envío; lo ya enviado no se cancela; un borrador caducado no se envía", async () => {
  let t = 5_000_000;
  await conEntorno({ ahora: () => t }, async (e) => {
    const b = await json(await post(e.url, "", { texto: "no lo mandes", pedidoId: ID1 }));
    const c = await post(e.url, `/${ID1}/cancelar`, {}); assert.equal(c.status, 200); assert.equal((await json(c)).estado, "cancelado");
    assert.equal((await post(e.url, `/${ID1}/cancelar`, {})).status, 200, "cancelar dos veces es inocuo");
    const tarde = await post(e.url, `/${ID1}/confirmar`, { textoHash: b.textoHash }); assert.equal(tarde.status, 409); assert.equal((await json(tarde)).codigo, "pedido_cancelado");

    const ID2 = "pedido-bbbbbbbbbbbbbbbb";
    const b2 = await json(await post(e.url, "", { texto: "este sí", pedidoId: ID2 }));
    await post(e.url, `/${ID2}/confirmar`, { textoHash: b2.textoHash }); await e.terminado();
    const yaEnviado = await post(e.url, `/${ID2}/cancelar`, {}); assert.equal(yaEnviado.status, 409); assert.equal((await json(yaEnviado)).codigo, "ya_enviado");

    const ID3 = "pedido-cccccccccccccccc";
    const b3 = await json(await post(e.url, "", { texto: "se me pasó el tiempo", pedidoId: ID3 }));
    t += TTL_BORRADOR_MS + 1;
    assert.equal((await post(e.url, `/${ID2}/cancelar`, {})).status, 409, "lo ya enviado nunca se presenta como expirado ni se cancela, pase el tiempo que pase");
    assert.equal((await json(await get(e.url, `/${ID2}`))).estado, "terminado");
    const cad = await post(e.url, `/${ID3}/confirmar`, { textoHash: b3.textoHash }); assert.equal(cad.status, 410); assert.equal((await json(cad)).codigo, "borrador_caducado");
    // Volver más tarde a un borrador abandonado dice «expirado» (no «no existe»), y se puede empezar de nuevo.
    const consulta = await get(e.url, `/${ID3}`); assert.equal(consulta.status, 200);
    const exp = await json(consulta); assert.equal(exp.estado, "expirado"); assert.equal(exp.ejecucion, "no_enviada"); assert.equal(exp.texto, undefined, "sin devolver el texto");
    assert.equal((await post(e.url, `/${ID3}/cancelar`, {})).status, 200);
    const nuevo = await post(e.url, "", { texto: "se me pasó el tiempo", pedidoId: ID3 }); assert.equal(nuevo.status, 201); assert.equal((await json(nuevo)).estado, "pendiente_confirmacion");
    assert.equal(e.procesados.length, 1, "solo el confirmado a tiempo");
  });
});

/* ───────── duplicados ───────── */

test("DUPLICADOS: cinco confirmaciones simultáneas (doble clic, reintentos) producen UNA sola ejecución, UN solo eco y UNA fila de bitácora", async () => {
  await conEntorno({}, async (e) => {
    const b = await json(await post(e.url, "", { texto: "paga la factura 1234", pedidoId: ID1 }));
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(e.url, `/${ID1}/confirmar`, { textoHash: b.textoHash })));
    const cuerpos = await Promise.all(rs.map(json));
    assert.ok(rs.every((r) => r.status === 202 || r.status === 200), rs.map((r) => r.status).join());
    assert.equal(cuerpos.filter((c) => c.duplicada === false).length, 1, "solo una es la original");
    await e.terminado();
    assert.equal(e.procesados.length, 1); assert.equal(e.ecos.length, 1); assert.equal(e.bitacora.filter((x) => x.evento === "confirmado").length, 1);
    // Reintento posterior (red lenta, botón pulsado otra vez): devuelve el estado, no repite.
    const otra = await post(e.url, `/${ID1}/confirmar`, { textoHash: b.textoHash });
    assert.equal(otra.status, 200); const o = await json(otra); assert.equal(o.duplicada, true); assert.equal(o.estado, "terminado");
    assert.equal(e.procesados.length, 1);
  });
});

test("DUPLICADOS: si el servidor perdió el borrador (reinicio), confirmar de nuevo devuelve el estado del ledger y NO vuelve a ejecutar", async () => {
  const repo = new RepoMemoria();
  const procesados: TelegramUpdate[] = [];
  const coordinador = new CoordinadorEntregasTelegram(repo, async (u) => { procesados.push(u); }, async () => undefined);
  const mk = () => ({ autorizar: async () => true, identidad: async () => PERSONA_A, entregas: { reservar: (u: TelegramUpdate) => coordinador.reservar(u, false), atender: (en: EntregaTelegramDurable, n: boolean) => coordinador.atender(en, n), obtener: (k: string) => repo.obtener(k) },
    entregaDurableHabilitada: true, eco: async () => undefined, rastrear: () => undefined } satisfies DepsRouterPedidos);
  const levantar = async (escenario: (url: string) => Promise<void>) => {
    const app = express(); app.use(express.json()); app.use("/p", crearRouterPedidos(mk()));
    const s = app.listen(0, "127.0.0.1"); await once(s, "listening"); const d = s.address(); assert.ok(d && typeof d !== "string");
    try { await escenario(`http://127.0.0.1:${d.port}/p`); } finally { s.closeAllConnections(); s.close(); }
  };
  let hash = "";
  await levantar(async (url) => {
    hash = (await json(await post(url, "", { texto: "una vez", pedidoId: ID1 }))).textoHash as string;
    assert.equal((await post(url, `/${ID1}/confirmar`, { textoHash: hash })).status, 202);
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.equal(procesados.length, 1);
  await levantar(async (url) => { // «reinicio»: almacén de borradores nuevo y vacío
    const r = await post(url, `/${ID1}/confirmar`, { textoHash: hash });
    assert.equal(r.status, 200); const c = await json(r); assert.equal(c.duplicada, true); assert.equal(c.estado, "terminado");
    assert.equal((await post(url, `/pedido-zzzzzzzzzzzzzzzz/confirmar`, { textoHash: hash })).status, 404, "un pedido que nunca existió no se crea por confirmar");
  });
  assert.equal(procesados.length, 1);
});

test("DUPLICADOS: el mismo pedidoId de dos personas son dos pedidos independientes, y cada una solo ve el suyo", async () => {
  await conEntorno({}, async (e) => {
    await enviar(e, "pedido de Ana", ID1, "a"); await enviar(e, "pedido de Beto", ID1, "b"); await e.terminado();
    assert.deepEqual(e.procesados.map((u) => [u.message?.from?.id, u.message?.text]).sort(), [[1001, "pedido de Ana"], [2002, "pedido de Beto"]]);
    const ra = await json(await get(e.url, `/${ID1}`, "a")), rb = await json(await get(e.url, `/${ID1}`, "b"));
    assert.notEqual(ra.ref, rb.ref);
    await enviar(e, "solo de Ana", "pedido-dddddddddddddddd", "a"); await e.terminado();
    assert.equal((await get(e.url, "/pedido-dddddddddddddddd", "b")).status, 404, "Beto no ve pedidos de Ana");
    assert.equal((await get(e.url, "/pedido-dddddddddddddddd", "visita")).status, 404);
  });
});

/* ───────── fallos ───────── */

test("FALLO DE RECEPCIÓN: si no se pudo registrar, no se envía nada, se dice, y el reintento funciona sin duplicar", async () => {
  await conEntorno({}, async (e) => {
    const b = await json(await post(e.url, "", { texto: "reintenta esto", pedidoId: ID1 }));
    e.repo.fallarReservas = 2;
    for (let i = 0; i < 2; i++) {
      const r = await post(e.url, `/${ID1}/confirmar`, { textoHash: b.textoHash });
      assert.equal(r.status, 503); assert.equal((await json(r)).codigo, "recepcion_fallida");
    }
    assert.equal(e.procesados.length, 0); assert.equal(e.ecos.length, 0); assert.equal(e.bitacora.length, 0);
    assert.equal((await post(e.url, `/${ID1}/confirmar`, { textoHash: b.textoHash })).status, 202);
    await post(e.url, `/${ID1}/confirmar`, { textoHash: b.textoHash });
    await e.terminado();
    assert.equal(e.procesados.length, 1);
  });
});

test("FALLO DE EJECUCIÓN: si el procesamiento revienta, queda «fallido · resultado incierto», se avisa por Telegram y NUNCA se repite solo", async () => {
  await conEntorno({ procesar: async () => { throw new Error("se cayó a mitad"); } }, async (e) => {
    assert.equal((await enviar(e, "operación con efectos")).status, 202);
    await e.terminado();
    const f = await json(await get(e.url, `/${ID1}`));
    assert.equal(f.estado, "fallido"); assert.equal(f.ejecucion, "incierta"); assert.equal(f.detalle, "resultado_incierto"); assert.match(String(f.mensaje), /No se repite solo/);
    assert.equal(e.avisosIncierta.length, 1, "el mismo aviso «Verificar resultado» que ya existe en Telegram");
    for (let i = 0; i < 3; i++) await post(e.url, `/${ID1}/confirmar`, { textoHash: hashTextoPedido("operación con efectos") });
    await e.terminado();
    assert.equal(e.procesados.length, 1, "ni confirmar otra vez ni consultar relanzan la operación");
  });
});

test("FALLOS COLATERALES: sin eco o sin bitácora el pedido se procesa igual (pero queda en el log); un fallo de lectura se dice sin filtrar detalles", async () => {
  const errores: unknown[][] = [];
  const original = console.error; console.error = (...a: unknown[]) => { errores.push(a); };
  try {
    await conEntorno({ deps: { eco: async () => { throw new Error("Telegram caído"); }, bitacora: async () => { throw new Error("Sheets caído"); } } }, async (e) => {
      assert.equal((await enviar(e, "sigue adelante")).status, 202);
      await e.terminado();
      assert.equal(e.procesados.length, 1);
    });
    await conEntorno({ deps: { entregas: { reservar: async () => { throw new Error("x"); }, atender: async () => undefined, obtener: async () => { throw new Error("ruta interna /srv/secreto"); } } } }, async (e) => {
      const r = await get(e.url, `/${ID1}`); assert.equal(r.status, 503); const t = await r.text(); assert.doesNotMatch(t, /srv|secreto/);
    });
  } finally { console.error = original; }
  assert.ok(errores.some((a) => String(a[0]).includes("bitácora")) && errores.some((a) => String(a[0]).includes("eco")), "los fallos colaterales quedan registrados");
});

/* ───────── límites y consultas ───────── */

test("LÍMITES: las confirmaciones por minuto están acotadas por persona; los reintentos del mismo pedido no consumen plaza", async () => {
  await conEntorno({}, async (e) => {
    const estados: number[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `pedido-lim${String(i).padStart(12, "0")}`;
      const b = await json(await post(e.url, "", { texto: `pedido ${i}`, pedidoId: id }));
      estados.push((await post(e.url, `/${id}/confirmar`, { textoHash: b.textoHash })).status);
    }
    assert.equal(estados.filter((s) => s === 202).length, 10); assert.deepEqual(estados.slice(10), [429, 429]);
    assert.equal((await post(e.url, `/pedido-lim${String(0).padStart(12, "0")}/confirmar`, { textoHash: hashTextoPedido("pedido 0") })).status, 200, "reintentar uno ya enviado sí se atiende");
    await e.terminado();
    assert.equal(e.procesados.length, 10);
  });
});

test("CONSULTA: el estado se cachea unos segundos (no se lee Sheets en cada sondeo) y un pedido inexistente es 404", async () => {
  await conEntorno({}, async (e) => {
    await enviar(e, "consulta"); await e.terminado();
    const antes = e.consultas.obtener;
    for (let i = 0; i < 5; i++) await get(e.url, `/${ID1}`);
    assert.ok(e.consultas.obtener - antes <= 1, `lecturas del ledger: ${e.consultas.obtener - antes}`);
    assert.equal((await get(e.url, "/pedido-inexistente-0000")).status, 404);
    assert.equal((await get(e.url, "/corto")).status, 400);
  });
});

/* ───────── solo lectura de la lógica: sin Telegram, Claude, Holded ni escritores ───────── */

test("el módulo de pedidos no importa Telegram (cliente), Claude, Holded, Gmail ni escritores: recibe sus dependencias", () => {
  const permitido = (origen: string) => origen.startsWith("node:") || origen === "express" || origen === "./" || origen.startsWith("./") ||
    origen === "../../telegram/durableDelivery" || origen === "../../telegram/types" || origen === "../chatLinkCommand";
  for (const archivo of readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "bitacoraSheet.ts")) {
    const codigo = readFileSync(join(__dirname, archivo), "utf8");
    for (const m of codigo.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) assert.ok(permitido(m[2]), `${archivo} importa «${m[2]}»`);
    assert.doesNotMatch(codigo, /\brequire\(|\beval\(|child_process|\bfetch\(|anthropic|askClaude|sendTelegram|holdedWriteCall/i, archivo);
  }
});
