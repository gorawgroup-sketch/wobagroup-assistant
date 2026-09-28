import { resumirSolicitudInterrumpida } from "./interruptedNotice";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CoordinadorEntregasTelegram,
  configuracionEntregasDurables,
  crearEntregaTelegram,
  type EntregaTelegramDurable,
  type RepositorioEntregasTelegram,
} from "./durableDelivery";
import type { TelegramUpdate } from "./types";

class RepoMemoria implements RepositorioEntregasTelegram {
  filas = new Map<string, EntregaTelegramDurable>();

  async reservar(entrega: EntregaTelegramDurable) {
    const existente = this.filas.get(entrega.clave);
    if (existente) return { entrega: { ...existente }, nueva: false };
    this.filas.set(entrega.clave, { ...entrega });
    return { entrega: { ...entrega }, nueva: true };
  }
  async reabrirCompletada(clave: string, entrega: EntregaTelegramDurable) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado !== "completada") return undefined;
    const { reabrirCompletadaTrasMs: _t, ...persistible } = entrega;
    const reabierta = { ...persistible, estado: "reservada" as const };
    this.filas.set(clave, reabierta);
    return { ...reabierta };
  }
  async obtener(clave: string) { const e = this.filas.get(clave); return e ? { ...e } : undefined; }
  async marcarIniciada(clave: string) {
    const anterior = this.filas.get(clave);
    const resultado = this.cambiar(clave, ["reservada"], "iniciada", true);
    return resultado && anterior ? { ...resultado, payload: anterior.payload } : undefined;
  }
  async marcarCompletada(clave: string) { this.cambiar(clave, ["iniciada"], "completada", true); }
  async marcarIncierta(clave: string) { return this.cambiar(clave, ["reservada", "iniciada"], "incierta", true); }
  async marcarNotificada(clave: string) {
    const actual = this.filas.get(clave);
    if (actual?.estado === "incierta") this.filas.set(clave, { ...actual, notificadoEn: 999 });
  }
  async listarRecuperables() {
    return [...this.filas.values()].filter((e) => e.estado !== "completada" && !e.notificadoEn).map((e) => ({ ...e }));
  }

  private cambiar(
    clave: string,
    permitidos: EntregaTelegramDurable["estado"][],
    estado: EntregaTelegramDurable["estado"],
    limpiar: boolean
  ) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = { ...actual, estado, payload: limpiar ? (estado === "completada" ? "" : resumirSolicitudInterrumpida(actual.payload)) : actual.payload, actualizadoEn: 500 };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function mensaje(updateId: number, texto = "hola"): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, date: 1, chat: { id: 7, type: "private" }, text: texto } };
}

function callback(updateId: number, callbackId: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: 7, is_bot: false },
      data: "evento_confirmar:propuesta-1",
      message: { message_id: 90, date: 1, chat: { id: 7, type: "private" } },
    },
  };
}

test("reserva antes de ejecutar y completa una entrega una sola vez", async () => {
  const repo = new RepoMemoria();
  const procesadas: number[] = [];
  const coordinador = new CoordinadorEntregasTelegram(repo, async (u) => { procesadas.push(u.update_id); }, async () => {});
  const reserva = await coordinador.reservar(mensaje(10), false);
  assert.equal(repo.filas.get(reserva.entrega.clave)?.estado, "reservada");
  await coordinador.atender(reserva.entrega, reserva.nueva);
  assert.deepEqual(procesadas, [10]);
  assert.equal(repo.filas.get(reserva.entrega.clave)?.estado, "completada");

  const repetida = await coordinador.reservar(mensaje(10), false);
  await coordinador.atender(repetida.entrega, repetida.nueva);
  assert.deepEqual(procesadas, [10]);
  assert.equal(coordinador.estado.duplicadas, 1);
});

test("dos callback_query distintos del mismo botón sensible comparten clave durable", () => {
  const a = crearEntregaTelegram(callback(20, "callback-a"), true, 1);
  const b = crearEntregaTelegram(callback(21, "callback-b"), true, 2);
  assert.equal(a.clave, b.clave);
  assert.notEqual(a.intentoId, b.intentoId);
});

test("mensajes diferentes nunca se deduplican solo por tener el mismo texto", () => {
  const a = crearEntregaTelegram(mensaje(30, "igual"), false, 1);
  const b = crearEntregaTelegram(mensaje(31, "igual"), false, 2);
  assert.notEqual(a.clave, b.clave);
});

test("recupera una reserva que nunca alcanzó a iniciar", async () => {
  const repo = new RepoMemoria();
  const entrega = crearEntregaTelegram(mensaje(40), false, 0);
  repo.filas.set(entrega.clave, entrega);
  let procesadas = 0;
  const coordinador = new CoordinadorEntregasTelegram(
    repo,
    async () => { procesadas++; },
    async () => {},
    { ahora: () => 10_000, demoraReservaMs: 1_000 }
  );
  await coordinador.recuperar();
  assert.equal(procesadas, 1);
  assert.equal(coordinador.estado.recuperadas, 1);
  assert.equal(repo.filas.get(entrega.clave)?.estado, "completada");
});

test("una entrega interrumpida después de iniciar se marca incierta y no se repite", async () => {
  const repo = new RepoMemoria();
  const entrega = { ...crearEntregaTelegram(mensaje(50), false, 0), estado: "iniciada" as const };
  repo.filas.set(entrega.clave, entrega);
  let procesadas = 0, avisos = 0;
  const coordinador = new CoordinadorEntregasTelegram(
    repo,
    async () => { procesadas++; },
    async () => { avisos++; },
    { ahora: () => 10_000, demoraIncertidumbreMs: 1_000 }
  );
  await coordinador.recuperar();
  assert.equal(procesadas, 0);
  assert.equal(avisos, 1);
  assert.equal(repo.filas.get(entrega.clave)?.estado, "incierta");
  assert.equal(repo.filas.get(entrega.clave)?.notificadoEn, 999);
});

test("si el handler falla, conserva incertidumbre y nunca auto-reintenta", async () => {
  const repo = new RepoMemoria();
  let llamadas = 0, avisos = 0;
  const coordinador = new CoordinadorEntregasTelegram(
    repo,
    async () => { llamadas++; throw new Error("resultado incierto"); },
    async () => { avisos++; }
  );
  const reserva = await coordinador.reservar(mensaje(60), false);
  await assert.rejects(coordinador.atender(reserva.entrega, true), /resultado incierto/);
  await coordinador.atender((await repo.obtener(reserva.entrega.clave))!, false);
  assert.equal(llamadas, 1);
  assert.equal(avisos, 1);
  assert.equal(repo.filas.get(reserva.entrega.clave)?.estado, "incierta");
});

test("configuración durable falla cerrada y acota ventanas", () => {
  assert.deepEqual(configuracionEntregasDurables({
    WOBI_TELEGRAM_DURABLE_ENABLED: "false",
    WOBI_TELEGRAM_RESERVATION_GRACE_MS: "999999",
    WOBI_TELEGRAM_UNCERTAIN_AFTER_MS: "1",
  }), { habilitado: false, demoraReservaMs: 30_000, demoraIncertidumbreMs: 30_000 });

  assert.equal(configuracionEntregasDurables({ WOBI_TELEGRAM_DURABLE_ENABLED: "errata" }).habilitado, true);
  assert.equal(configuracionEntregasDurables({}).habilitado, true);
});

test("si falla la respuesta del checkpoint, relee la reserva y no la pierde", async () => {
  const repo = new RepoMemoria();
  const marcarReal = repo.marcarIniciada.bind(repo);
  let primerIntento = true;
  repo.marcarIniciada = async (clave) => {
    if (primerIntento) {
      primerIntento = false;
      throw new Error("respuesta de Sheets perdida");
    }
    return marcarReal(clave);
  };
  let procesadas = 0;
  const coordinador = new CoordinadorEntregasTelegram(
    repo,
    async () => { procesadas++; },
    async () => {},
    { demoraReservaMs: 1 }
  );
  const reserva = await coordinador.reservar(mensaje(70), false);
  await assert.rejects(coordinador.atender(reserva.entrega, true), /respuesta de Sheets perdida/);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(procesadas, 1);
  assert.equal(repo.filas.get(reserva.entrega.clave)?.estado, "completada");
});

test("una ejecución local larga no se declara incierta mientras continúa activa", async () => {
  const repo = new RepoMemoria();
  let ahora = 0;
  let liberar!: () => void;
  const bloqueada = new Promise<void>((resolve) => { liberar = resolve; });
  let avisos = 0;
  const coordinador = new CoordinadorEntregasTelegram(
    repo,
    async () => bloqueada,
    async () => { avisos++; },
    { ahora: () => ahora, demoraIncertidumbreMs: 1_000 }
  );
  const reserva = await coordinador.reservar(mensaje(80), false);
  const ejecucion = coordinador.atender(reserva.entrega, true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  ahora = 10_000;
  await coordinador.atender((await repo.obtener(reserva.entrega.clave))!, false);
  assert.equal(repo.filas.get(reserva.entrega.clave)?.estado, "iniciada");
  assert.equal(avisos, 0);

  liberar();
  await ejecucion;
  coordinador.cerrar();
  assert.equal(repo.filas.get(reserva.entrega.clave)?.estado, "completada");
});

function aprobar(updateId: number, ahoraSeg: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: 7, is_bot: false },
      data: "gasto_aprobar:propuesta-1:abcd1234",
      message: { message_id: 4627, date: ahoraSeg, chat: { id: 7, type: "private" } },
    },
  };
}

test("«Aprobar selección» repetido tras un primer toque completado sin efecto vuelve a ejecutarse pasado el margen", async () => {
  const repo = new RepoMemoria();
  const procesadas: number[] = [];
  let ahora = 1_000_000;
  const coordinador = new CoordinadorEntregasTelegram(repo, async (u) => { procesadas.push(u.update_id); }, async () => {}, { ahora: () => ahora });
  const primera = await coordinador.reservar(aprobar(1, 1), true);
  await coordinador.atender(primera.entrega, primera.nueva);
  assert.deepEqual(procesadas, [1]);
  assert.equal(repo.filas.get(primera.entrega.clave)?.estado, "completada");
  repo.filas.get(primera.entrega.clave)!.actualizadoEn = ahora;

  // Un doble toque a los pocos segundos sigue siendo un duplicado.
  ahora += 5_000;
  const rebote = await coordinador.reservar(aprobar(2, 2), true);
  assert.equal(rebote.nueva, false);
  await coordinador.atender(rebote.entrega, rebote.nueva);
  assert.deepEqual(procesadas, [1]);

  // Pasado el margen es una decisión nueva del operador y se ejecuta.
  ahora += 60_000;
  const reintento = await coordinador.reservar(aprobar(3, 3), true);
  assert.equal(reintento.nueva, true);
  await coordinador.atender(reintento.entrega, reintento.nueva);
  assert.deepEqual(procesadas, [1, 3]);
  assert.equal(coordinador.estado.reabiertas, 1);
});

test("solo «Aprobar selección» se reabre: las demás acciones sensibles conservan la deduplicación total", async () => {
  const repo = new RepoMemoria();
  const procesadas: number[] = [];
  let ahora = 1_000_000;
  const coordinador = new CoordinadorEntregasTelegram(repo, async (u) => { procesadas.push(u.update_id); }, async () => {}, { ahora: () => ahora });
  const crear = (id: number): TelegramUpdate => ({
    update_id: id,
    callback_query: { id: `cb-${id}`, from: { id: 7, is_bot: false }, data: "gasto_nuevo_conciliar:propuesta-1",
      message: { message_id: 4627, date: 1, chat: { id: 7, type: "private" } } },
  });
  const a = await coordinador.reservar(crear(1), true);
  await coordinador.atender(a.entrega, a.nueva);
  ahora += 10 * 60_000;
  const b = await coordinador.reservar(crear(2), true);
  await coordinador.atender(b.entrega, b.nueva);
  assert.equal(b.nueva, false);
  assert.deepEqual(procesadas, [1]);
});

test("una entrega incierta de «Aprobar selección» nunca se reabre por el margen", async () => {
  const repo = new RepoMemoria();
  let ahora = 1_000_000;
  const coordinador = new CoordinadorEntregasTelegram(repo, async () => { throw new Error("cayó a mitad"); }, async () => {}, { ahora: () => ahora });
  const a = await coordinador.reservar(aprobar(1, 1), true);
  await coordinador.atender(a.entrega, a.nueva).catch(() => undefined);
  assert.equal(repo.filas.get(a.entrega.clave)?.estado, "incierta");
  ahora += 10 * 60_000;
  const b = await coordinador.reservar(aprobar(2, 2), true);
  assert.equal(b.nueva, false);
});
