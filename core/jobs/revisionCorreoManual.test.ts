import assert from "node:assert/strict";
import test from "node:test";
import {
  avisarYRegistrarRevisionesInterrumpidas,
  configurarRevisionCorreoManualParaPruebas,
  ejecutarRevisionCorreoManual,
  reanudarRevisionesCorreoInterrumpidas,
  vigilarReanudacionesPendientes,
} from "./revisionCorreoManual";
import type { ResultadoRevisarCorreo } from "./revisarCorreoNuevo";
import type { ReanudacionReclamada, ReanudacionRevisionCorreo } from "../gmail/automatico/reanudacion";

const CHAT = 8731933107;

function escenario(parciales: {
  resultado?: () => Promise<ResultadoRevisarCorreo>;
  registrar?: (r: ReanudacionRevisionCorreo) => Promise<void>;
  reclamar?: () => Promise<Array<ReanudacionRevisionCorreo | ReanudacionReclamada>>;
  cierre?: () => boolean;
  sinPregunta?: boolean;
  activoSinPreguntaViva?: () => Promise<boolean>;
  reenviarPreguntaDelActivo?: (chatId: number, encabezado: string) => Promise<{ tipo: "propuesta" | "conciliacion" | "conciliacion_ambigua"; descripcion: string } | undefined>;
} = {}) {
  const enviados: Array<{ chatId: number; texto: string; botones?: unknown }> = [];
  const registros: ReanudacionRevisionCorreo[] = [];
  const iniciados: ReanudacionRevisionCorreo[] = [];
  const latidos: Array<string | undefined> = [];
  const cerrados: number[] = [];
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
    iniciarRevisionEnCurso: async (r) => { iniciados.push(r); },
    latirRevisionEnCurso: async (_chatId, progreso) => { latidos.push(progreso); },
    cerrarRegistroRevision: async (chatId) => { cerrados.push(chatId); },
    reclamarReanudacionesPendientes: async () => (await (parciales.reclamar ?? (async () => []))())
      .map(x => "registro" in x ? x : { registro: x, huerfana: false }),
    intervaloLatidoMs: 5,
    enviar: async (chatId, texto) => { enviados.push({ chatId, texto }); },
    enviarConBotones: async (chatId, texto, botones) => { enviados.push({ chatId, texto, botones }); return 1; },
    cierreSolicitado: parciales.cierre ?? (() => false),
    activoSinPreguntaViva: parciales.activoSinPreguntaViva ?? (async () => parciales.sinPregunta ?? false),
    reenviarPreguntaDelActivo: parciales.reenviarPreguntaDelActivo ?? (async () => undefined),
  });
  return { enviados, registros, iniciados, latidos, cerrados, lanzamientos, restaurar, liberar: () => liberar?.() };
}

test("al recibir SIGTERM con una revisión manual en curso: registro durable + aviso inmediato con el último avance", async () => {
  const e = escenario();
  const revision = ejecutarRevisionCorreoManual(CHAT);
  await avisarYRegistrarRevisionesInterrumpidas(123_456);
  assert.equal(e.registros.length, 1);
  assert.deepEqual(e.registros[0], { chatId: CHAT, interrumpidaEn: 123_456, reanudaciones: 0, progreso: "⏳ Mensajes analizados: 39/50." });
  assert.equal(e.enviados.length, 1);
  assert.match(e.enviados[0].texto, /se reinicia por un despliegue nuevo/);
  assert.match(e.enviados[0].texto, /Último avance: Mensajes analizados: 39\/50\./);
  assert.match(e.enviados[0].texto, /la retomo automáticamente/);
  e.liberar();
  await revision;
  // Terminada la revisión, un SIGTERM posterior ya no tiene nada que registrar.
  await avisarYRegistrarRevisionesInterrumpidas(123_457);
  assert.equal(e.registros.length, 1);
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
  assert.equal(e.cerrados.length, 0);
  e.restaurar();
});

test("si la revisión termina por sí sola después del SIGTERM, cierra el registro y anuncia el cierre normal", async () => {
  const e = escenario({ resultado: async () => ({ correosRevisados: 2 }), cierre: () => true });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.deepEqual(e.cerrados, [CHAT]);
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
  assert.match(e.enviados[0].texto, /3 veces seguidas por reinicios del servicio/);
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

test("un correo activo SIN pregunta viva se dice tal cual y ofrece reprocesarlo o descartarlo (caso Televic)", async () => {
  const e = escenario({
    sinPregunta: true,
    resultado: async () => ({ correosRevisados: 0, activoBloqueando: { asunto: "Fwd: €67.73 - Televic", de: "Carlos" } }),
  });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.match(e.enviados[0].texto, /no tiene ninguna pregunta viva en el chat/);
  assert.doesNotMatch(e.enviados[0].texto, /los botones de esa pregunta siguen arriba/);
  const datos = JSON.stringify(e.enviados[0].botones);
  assert.match(datos, /colacorreo_reprocesaractivo/);
  assert.match(datos, /colacorreo_descartaractivo/);
  e.restaurar();
});

test("no se ofrece reprocesar un correo con pendientesRestantes=0: ya está resuelto, solo falta confirmar leído en Gmail", async () => {
  // activoSinPreguntaViva ya descarta este caso por su cuenta (documentado y probado aparte); aquí se comprueba
  // que revisionCorreoManual respeta lo que esa dependencia decide sin duplicar el criterio.
  const e = escenario({
    activoSinPreguntaViva: async () => false,
    resultado: async () => ({ correosRevisados: 0, activoBloqueando: { asunto: "Factura ya resuelta", de: "Proveedor" } }),
  });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.match(e.enviados[0].texto, /Ya tienes un correo activo esperando tu respuesta: "Factura ya resuelta"/);
  assert.doesNotMatch(e.enviados[0].texto, /no tiene ninguna pregunta viva/);
  e.restaurar();
});

test("si no se pudo comprobar la pregunta viva, el aviso es el de siempre (nunca se afirma que falta algo sin comprobarlo)", async () => {
  const e = escenario({
    sinPregunta: false,
    resultado: async () => ({ correosRevisados: 0, activoBloqueando: { asunto: "Factura X", de: "Proveedor" } }),
  });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.match(e.enviados[0].texto, /Ya tienes un correo activo esperando tu respuesta/);
  e.restaurar();
});

test("si la revisión termina mientras el registro del SIGTERM sigue en vuelo, el cierre espera al INSERT", async () => {
  const orden: string[] = [];
  let terminarRegistro: (() => void) | undefined;
  let cierre = false;
  const e = escenario({
    registrar: async () => { await new Promise<void>(resolve => { terminarRegistro = resolve; }); orden.push("insert"); },
    cierre: () => cierre,
  });
  const revision = ejecutarRevisionCorreoManual(CHAT);
  cierre = true;
  const sigterm = avisarYRegistrarRevisionesInterrumpidas();
  await new Promise(resolve => setImmediate(resolve));
  e.liberar(); // la revisión termina con el INSERT todavía en vuelo
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(e.cerrados, []); // aún no: espera al registro
  terminarRegistro!();
  await Promise.all([sigterm, revision]);
  assert.deepEqual(orden, ["insert"]);
  assert.deepEqual(e.cerrados, [CHAT]);
  e.restaurar();
});

test("la vigilancia recoge una reanudación escrita DESPUÉS de arrancar (orden real de Railway) y para al pedirse el cierre", async () => {
  const filas: ReanudacionRevisionCorreo[] = [];
  let cierre = false;
  const e = escenario({
    resultado: async () => ({ correosRevisados: 1 }),
    reclamar: async () => filas.splice(0),
    cierre: () => cierre,
  });
  const seguidas: Array<Promise<void>> = [];
  const relanzadas: number[] = [];
  const parar = vigilarReanudacionesPendientes({ seguir: (p) => { seguidas.push(p); }, intervaloInicialMs: 5, ventanaInicialMs: 60_000,
    alRelanzar: (n) => { relanzadas.push(n); } });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(e.lanzamientos, []); // al arrancar no había nada: no se inventa nada
  filas.push({ chatId: CHAT, interrumpidaEn: Date.now(), reanudaciones: 0 }); // el contenedor viejo escribe tras el SIGTERM
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(e.lanzamientos, [CHAT]);
  assert.deepEqual(relanzadas, [1]);
  await Promise.all(seguidas);
  // Con el cierre pedido, este proceso ya no reclama (la fila es para el siguiente).
  cierre = true;
  filas.push({ chatId: CHAT, interrumpidaEn: Date.now(), reanudaciones: 0 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(filas.length, 1);
  assert.deepEqual(e.lanzamientos, [CHAT]);
  parar();
  e.restaurar();
});

// Segunda versión (2026-09-28 tarde): un contenedor arrancado con `npm start` nunca recibe el
// SIGTERM (npm es PID 1) y muere por SIGKILL sin escribir nada. La fila `en_curso` con latido
// existe desde el principio para que el siguiente proceso lo note por el silencio.
test("una revisión en curso deja su fila con latido periódico y la borra al terminar", async () => {
  const e = escenario();
  const revision = ejecutarRevisionCorreoManual(CHAT, { reanudaciones: 2 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(e.iniciados.length, 1);
  assert.equal(e.iniciados[0].chatId, CHAT);
  assert.equal(e.iniciados[0].reanudaciones, 2);
  assert.ok(e.latidos.length >= 2, `latidos: ${e.latidos.length}`);
  assert.equal(e.latidos[0], "⏳ Mensajes analizados: 39/50.");
  assert.deepEqual(e.cerrados, []);
  e.liberar();
  await revision;
  assert.deepEqual(e.cerrados, [CHAT]);
  const latidosAlTerminar = e.latidos.length;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(e.latidos.length, latidosAlTerminar); // el latido se apaga con la revisión
  e.restaurar();
});

test("una revisión que falla cierra su registro: no se retoma sola un fallo que se repetiría", async () => {
  const e = escenario({ resultado: async () => { throw new Error("Gmail caído"); } });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.deepEqual(e.cerrados, [CHAT]);
  e.restaurar();
});

test("una revisión interrumpida por SIGTERM NO borra la fila: ya es `pendiente` para el siguiente proceso", async () => {
  const e = escenario({ resultado: async () => ({ correosRevisados: 0, interrumpida: true }), cierre: () => true });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.deepEqual(e.cerrados, []);
  e.restaurar();
});

test("una fila huérfana (latido apagado, muerte sin aviso) se retoma explicando que el servicio se cortó de golpe", async () => {
  const ahora = 5_000_000;
  const e = escenario({
    resultado: async () => ({ correosRevisados: 1 }),
    reclamar: async () => [{ registro: { chatId: CHAT, interrumpidaEn: ahora - 90_000, reanudaciones: 0, progreso: "⏳ Candidatos verificados: 8/30." }, huerfana: true }],
  });
  const seguidas: Array<Promise<void>> = [];
  const relanzadas = await reanudarRevisionesCorreoInterrumpidas({ ahora, seguir: (p) => { seguidas.push(p); } });
  assert.equal(relanzadas, 1);
  await Promise.all(seguidas);
  assert.match(e.enviados[0].texto, /se cortó de golpe/);
  assert.match(e.enviados[0].texto, /Último avance: Candidatos verificados: 8\/30\./);
  assert.match(e.enviados[1].texto, /Revisión extraordinaria completa/);
  assert.equal(e.iniciados[0]?.reanudaciones, 1);
  e.restaurar();
});

test("el SIGTERM espera a que el INSERT `en_curso` aterrice antes de pasar la fila a `pendiente`", async () => {
  const orden: string[] = [];
  let terminarInicio: (() => void) | undefined;
  const e = escenario();
  const restaurarInicio = configurarRevisionCorreoManualParaPruebas({
    iniciarRevisionEnCurso: async () => { await new Promise<void>(resolve => { terminarInicio = resolve; }); orden.push("en_curso"); },
    registrarReanudacionPendiente: async () => { orden.push("pendiente"); },
  });
  const revision = ejecutarRevisionCorreoManual(CHAT);
  const sigterm = avisarYRegistrarRevisionesInterrumpidas();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(orden, []); // el registro `pendiente` no se adelanta al INSERT en vuelo
  terminarInicio!();
  await sigterm;
  assert.deepEqual(orden, ["en_curso", "pendiente"]);
  e.liberar();
  await revision;
  restaurarInicio();
  e.restaurar();
});

// Caso real (Carlos, 2026-09-28 20:23): la revisión terminaba con «los botones siguen arriba» y la pregunta viva
// («¿conciliar Airalo?») estaba fuera de vista. Ahora se reenvía la pregunta real al final del chat.
test("con un correo activo que sí tiene decisión pendiente, se reenvía esa pregunta con botones y no el aviso genérico", async () => {
  const reenvios: string[] = [];
  const e = escenario({
    resultado: async () => ({ correosRevisados: 0, activoBloqueando: { asunto: "$ 12,50 - Airalo - Revolut", de: "Juan" } }),
    reenviarPreguntaDelActivo: async (_chat, encabezado) => { reenvios.push(encabezado); return { tipo: "conciliacion", descripcion: "Airalo — 12.5 USD" }; },
  });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.equal(reenvios.length, 1);
  assert.match(reenvios[0], /espera tu respuesta al correo "\$ 12,50 - Airalo - Revolut"/);
  assert.equal(e.enviados.length, 0); // ni «siguen arriba» ni «Reprocesar»: la pregunta ya está abajo con sus botones
  e.restaurar();
});

test("si el correo activo no tiene ninguna decisión pendiente, sigue ofreciéndose «Reprocesar este correo»", async () => {
  const e = escenario({
    resultado: async () => ({ correosRevisados: 0, activoBloqueando: { asunto: "Televic", de: "X" } }),
    reenviarPreguntaDelActivo: async () => undefined,
    sinPregunta: true,
  });
  await ejecutarRevisionCorreoManual(CHAT);
  assert.equal(e.enviados.length, 1);
  assert.match(e.enviados[0].texto, /no tiene ninguna pregunta viva/);
  e.restaurar();
});
