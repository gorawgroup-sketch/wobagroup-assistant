import assert from "node:assert/strict";
import test from "node:test";
import type { Propuesta } from "../google/proposalSheet";
import { continuarConExplicacion, iniciarExplicacion, quitarReglaPorBoton, type DependenciasExplicacion } from "./explicacionCashflow";
import { explicacionVigente, TTL_EXPLICACION_MS } from "./pendienteExplicacionStore";
import type { ReglaAgregada } from "./reglasAgregadas";

const propuesta: Propuesta = { id: "p1", empresa: "WOBA", bloqueSugerido: "gastos_consultores_mes_actual" as never, clienteOConcepto: "To Calzada Jimenez, Carlos Nomina Septiembre", semana: "S40", valor: 2064.25, chatId: 7, messageId: 99, creadoEn: 1 };

function montar(prop: Propuesta | null = propuesta) {
  const log = { consumida: false, reglas: [] as Array<Omit<ReglaAgregada, "id" | "creadoEn">>, editados: [] as Array<{ texto: string; botones: unknown }>, enviados: [] as string[], pendientes: [] as unknown[], quitadas: [] as string[] };
  const d: DependenciasExplicacion = {
    obtenerPropuesta: async () => prop ?? undefined,
    consumirPropuesta: async () => { log.consumida = true; return prop ?? undefined; },
    guardarPendiente: async (x) => { log.pendientes.push(x); },
    registrarRegla: async (x) => { log.reglas.push(x); return { ...x, id: "r1", creadoEn: "ahora" }; },
    quitarRegla: async (id) => { log.quitadas.push(id); return id === "r1"; },
    enviarConBotones: async (_c, texto) => { log.enviados.push(texto); return 555; },
    editar: async (_c, _m, texto, botones) => { log.editados.push({ texto, botones }); },
  };
  return { d, log };
}

test("paso 1: el botón pide una frase, guarda la espera apuntando al mensaje de WOBI y NO toca la propuesta", async () => {
  const { d, log } = montar();
  const r = await iniciarExplicacion("p1", 7, d);
  assert.match(r, /Responde al mensaje/);
  assert.match(log.enviados[0], /Responde A ESTE MENSAJE/); assert.match(log.enviados[0], /2064\.25 €/);
  assert.deepEqual(log.pendientes, [{ chatId: 7, propuestaId: "p1", promptMessageId: 555 }]);
  assert.equal(log.consumida, false);
  assert.match(await iniciarExplicacion("p1", 99, d), /otro chat/);
  assert.match(await iniciarExplicacion("p1", 7, montar(null).d), /ya no está disponible/);
});

test("paso 2, caso de Carlos: la explicación crea la regla «nomina» → «Nóminas», cierra la propuesta como no registrada y ofrece quitarla", async () => {
  const { d, log } = montar();
  const msg = await continuarConExplicacion({ chatId: 7, propuestaId: "p1", promptMessageId: 555, creadoEn: Date.now() }, "Esto hace parte de la línea Nóminas y ya viene sumado con la de Heidi Antunes", d);
  assert.equal(log.consumida, true);
  assert.deepEqual(log.reglas[0].palabrasClave, ["nomina"]);
  assert.equal(log.reglas[0].lineaCashflow, "Nóminas"); assert.equal(log.reglas[0].empresa, "WOBA"); assert.equal(log.reglas[0].tipo, "gasto");
  assert.match(log.editados[0].texto, /no se registra.*El banco, Holded y el cashflow no se modificaron/s);
  assert.match(log.editados[0].texto, /«nomina» ya van sumados en «Nóminas»/);
  assert.deepEqual(log.editados[0].botones, [[{ text: "↩️ Quitar esta regla", callback_data: "cf_regla_quitar:r1" }]]);
  assert.match(msg, /Regla r1/);
});

test("si de la frase no sale ninguna palabra clave identificable NO se aprende nada y la propuesta queda intacta", async () => {
  const { d, log } = montar();
  const msg = await continuarConExplicacion({ chatId: 7, propuestaId: "p1", promptMessageId: 555, creadoEn: Date.now() }, "Ya está registrado en otro sitio", d);
  assert.match(msg, /No pude identificar qué palabra/);
  assert.equal(log.consumida, false); assert.equal(log.reglas.length, 0); assert.equal(log.editados.length, 0);
});

test("quitar la regla y propuesta que ya no existe", async () => {
  const { d } = montar();
  assert.match(await quitarReglaPorBoton("r1", d), /Regla eliminada/);
  assert.match(await quitarReglaPorBoton("zzz", d), /ya no existe/);
  assert.match(await continuarConExplicacion({ chatId: 7, propuestaId: "p1", promptMessageId: 1, creadoEn: Date.now() }, "nómina", montar(null).d), /ya no está disponible/);
});

test("la espera de explicación solo vale 15 minutos y solo si responde al mensaje de WOBI: una conversación normal no se confunde con una explicación", () => {
  const p = { chatId: 7, propuestaId: "p1", promptMessageId: 555, creadoEn: 1000 };
  assert.equal(explicacionVigente(p, 555, 1000 + 60_000), true);
  assert.equal(explicacionVigente(p, undefined, 1000 + 60_000), true, "sin respuesta a otro mensaje, dentro del plazo");
  assert.equal(explicacionVigente(p, 123, 1000 + 60_000), false, "responde a otro mensaje");
  assert.equal(explicacionVigente(p, 555, 1000 + TTL_EXPLICACION_MS + 1), false, "caducada");
});
