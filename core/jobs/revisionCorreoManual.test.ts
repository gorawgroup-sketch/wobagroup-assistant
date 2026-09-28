import assert from "node:assert/strict";
import test from "node:test";
import {
  avisarYRegistrarRevisionesInterrumpidas,
  chatsConRevisionManualEnCurso,
  configurarRevisionCorreoManualParaPruebas,
  ejecutarRevisionCorreoManual,
  reanudarRevisionesCorreoInterrumpidas,
} from "./revisionCorreoManual";
import type { ResultadoRevisarCorreo } from "./revisarCorreoNuevo";
import type { ReanudacionRevisionCorreo } from "../gmail/automatico/reanudacion";

const CHAT = 8731933107;

function escenario(parciales: {
  resultado?: () => Promise<ResultadoRevisarCorreo>;
  registrar?: (r: ReanudacionRevisionCorreo) => Promise<void>;
  reclamar?: () => Promise<ReanudacionRevisionCorreo[]>;
  cierre?: () => boolean;
} = {}) {
  const enviados: Array<{ chatId: number; texto: string }> = [];
  const registros: ReanudacionRevisionCorreo[] = [];
  const cancelados: number[] = [];
  const lanzamientos: number[] = [];
  let liberar: (() => void) | undefined;
  const restaurar = configurarRevisionCorreoManualParaPruebas({
    revisarCorreoNuevo: async (chatId) => {
      lanzamientos.push(chatId);
      if (parciales.resultado) return parciales.resultado();
      // Por defecto la revisión queda «en curso» hasta que la prueba la libere.
      await new Promise<void>(resolve => { liberar = resolve; });
      return { correosRevisados: 3 };
    },
    progresoRevisionAutomatica: () => "⏳ Mensajes analizados: 39/50.",
    registrarReanudacionPendiente: parciales.registrar ?? (async (r) => { registros.push(r); }),
    cancelarReanudacionPendiente: async (chatId) => { cancelados.push(chatId); },
    reclamarReanudacionesPendientes: parciales.reclamar ?? (async () => []),
    enviar: async (chatId, texto) => { enviados.push({ chatId, texto }); },
    enviarConBotones: async (chatId, texto) => { enviados.push({ chatId, texto }); return 1; },
    cierreSolicitado: parciales.cierre ?? (() => false),
  });
  return { enviados, registros, cancelados, lanzamientos, restaurar, liberar: () => liberar?.() };
}

test("al recibir SIGTERM con una revisión manual en curso: registro durable + aviso inmediato con el último avance", async () => {
  const e = escenario();
  const revision = ejecutarRevisionCorreoManual(CHAT);
  assert.deepEqual(chatsConRevisionManualEnCurso(), [CHAT]);
  await avisarYRegistrarRevisionesInterrumpidas(123_456);
  assert.equal(e.registros.length, 1);
  assert.deepEqual(e.registros[0], { chatId: CHAT, interrumpidaEn: 123_456, reanudaciones: 0, progreso: "⏳ Mensajes analizados: 39/50." });
  assert.equal(e.enviados.length, 1);
  assert.match(e.enviados[0].texto, /se reinicia por un despliegue nuevo/);
  assert.match(e.enviados[0].texto, /Último avance: Mensajes analizados: 39\/50\./);
  assert.match(e.enviados[0].texto, /la retomo automáticamente/);
  e.liberar();
  await revision;
  assert.deepEqual(chatsConRevisionManualEnCurso(), []);
  e.restaurar();
});

test("si Postgres no deja registrar la reanudación, el aviso pide relanzar a mano en vez de prometerla", async () => {
  const e = escenario({ registrar: async () => { throw new Error("conexión perdida"); } });
  const revision = ejecutarRevisionCorreoManual(CHAT);
  await avisarYRegistrarRevisionesInterrumpidas();
  assert.equal(e.enviados.length, 1);
  assert.match(e.enviados[0].texto, /envía \/revisarcorreo cuando arranque/);
  assert.doesNotMatch(e.enviados[0].texto, /la retomo automáticamente/);
  e.liberar();
  await revision;
  e.restaurar();
});

test("sin revisiones manuales en curso, el SIGTERM no escribe ni avisa nada", async () => {
  const e = escenario();
  await avisarYRegistrarRevisionesInterrumpidas();
  assert.equal(e.registros.length, 0);
  assert.equal(e.enviados.length, 0);
  e.restaurar();
});

test("una revisión interrumpida por el cierre no anuncia «completa» ni «error»", async () => {
  const e = escenario({ resultado: async () => ({ correosRevisados: 0, interrumpida: true }), cierre: () => true });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.equal(e.enviados.length, 0);
  assert.equal(e.cancelados.length, 0);
  e.restaurar();
});

test("si la revisión termina por sí sola después del SIGTERM, cancela la reanudación y anuncia el cierre normal", async () => {
  const e = escenario({ resultado: async () => ({ correosRevisados: 2 }), cierre: () => true });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.deepEqual(e.cancelados, [CHAT]);
  assert.equal(e.enviados.length, 1);
  assert.match(e.enviados[0].texto, /Revisión extraordinaria completa — 2 correo/);
  e.restaurar();
});

test("al arrancar, una reanudación pendiente avisa, relanza la misma revisión y la cuenta como trabajo en curso", async () => {
  const ahora = 5_000_000;
  const e = escenario({
    resultado: async () => ({ correosRevisados: 1 }),
    reclamar: async () => [{ chatId: CHAT, interrumpidaEn: ahora - 60_000, reanudaciones: 1, progreso: "⏳ 39/50" }],
  });
  const seguidas: Array<Promise<void>> = [];
  const relanzadas = await reanudarRevisionesCorreoInterrumpidas({ ahora, seguir: (p) => { seguidas.push(p); } });
  assert.equal(relanzadas, 1);
  assert.equal(seguidas.length, 1);
  await Promise.all(seguidas);
  assert.deepEqual(e.lanzamientos, [CHAT]);
  assert.match(e.enviados[0].texto, /▶️ Retomo la revisión de correo/);
  assert.match(e.enviados[1].texto, /Revisión extraordinaria completa — 1 correo/);
  e.restaurar();
});

test("la revisión relanzada hereda el contador de reanudaciones: un nuevo SIGTERM lo registra incrementado", async () => {
  const ahora = 5_000_000;
  const e = escenario({
    reclamar: async () => [{ chatId: CHAT, interrumpidaEn: ahora - 1_000, reanudaciones: 1 }],
  });
  const seguidas: Array<Promise<void>> = [];
  await reanudarRevisionesCorreoInterrumpidas({ ahora, seguir: (p) => { seguidas.push(p); } });
  await avisarYRegistrarRevisionesInterrumpidas(ahora + 10_000);
  assert.equal(e.registros[0]?.reanudaciones, 2);
  e.liberar();
  await Promise.all(seguidas);
  e.restaurar();
});

test("tras tres reanudaciones encadenadas se avisa y no se relanza; una caducada se descarta en silencio", async () => {
  const ahora = 5_000_000;
  const e = escenario({
    reclamar: async () => [
      { chatId: CHAT, interrumpidaEn: ahora - 1_000, reanudaciones: 3 },
      { chatId: 42, interrumpidaEn: ahora - 24 * 60 * 60 * 1000, reanudaciones: 0 },
    ],
  });
  const relanzadas = await reanudarRevisionesCorreoInterrumpidas({ ahora });
  assert.equal(relanzadas, 0);
  assert.deepEqual(e.lanzamientos, []);
  assert.equal(e.enviados.length, 1);
  assert.equal(e.enviados[0].chatId, CHAT);
  assert.match(e.enviados[0].texto, /3 veces seguidas por despliegues/);
  e.restaurar();
});

test("un correo activo bloqueando y un fallo siguen avisando como antes del cambio", async () => {
  const e = escenario({ resultado: async () => ({ correosRevisados: 0, activoBloqueando: { asunto: "Factura X", de: "Proveedor" } }) });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.match(e.enviados[0].texto, /Ya tienes un correo activo esperando tu respuesta: "Factura X"/);
  e.restaurar();
  const f = escenario({ resultado: async () => { throw new Error("Gmail caído"); } });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.match(f.enviados[0].texto, /Hubo un error revisando el correo/);
  f.restaurar();
});
