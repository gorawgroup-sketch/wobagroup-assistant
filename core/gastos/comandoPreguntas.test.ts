import assert from "node:assert/strict";
import test from "node:test";
import { ejecutarComandoPreguntas, parsearComandoPreguntas, type DependenciasComandoPreguntas } from "./comandoPreguntas";

test("el comando solo se reconoce con barra o con la frase «preguntas pendientes»; una palabra suelta es conversación", () => {
  assert.equal(parsearComandoPreguntas("/preguntas"), "");
  assert.equal(parsearComandoPreguntas("/preguntas metro"), "metro");
  assert.equal(parsearComandoPreguntas("preguntas pendientes Metro Art"), "Metro Art");
  assert.equal(parsearComandoPreguntas("  /Preguntas 581,92 "), "581,92");
  for (const t of ["pendientes de hoy", "¿qué preguntas hay?", "/preguntasx", "preguntas sobre el cashflow", "hola /preguntas"]) assert.equal(parsearComandoPreguntas(t), undefined, t);
});

function montar() {
  const enviados: string[] = [];
  const simple = (id: string, descripcionGasto: string, proveedor: string, monto: number) => ({ id, descripcionGasto, proveedor, monto }) as never;
  const deps: DependenciasComandoPreguntas = {
    propuestas: async () => [],
    simples: async () => [simple("a", "METRO ART HOTEL — 581.92 USD", "Metro Art Hotel", 581.92), simple("b", "Farm Air Market — 6.82 USD", "Farm Air Market", 6.82), simple("c", "TRIP.COM — 142.48 EUR", "TRIP.COM", 142.48)],
    ambiguas: async () => [],
    reenviarPropuesta: async () => undefined,
    reenviarSimple: async (p) => { enviados.push((p as { id: string }).id); },
    reenviarAmbigua: async () => undefined,
    seguros: async () => [],
    reenviarSeguros: async () => undefined,
  };
  return { deps, enviados };
}
test("con texto que identifica una sola pregunta la reenvía y no toca nada más", async () => {
  const { deps, enviados } = montar();
  const r = await ejecutarComandoPreguntas(1, "metro", deps);
  assert.deepEqual(enviados, ["a"]); assert.match(r.texto, /Reenvié al final del chat: Conciliar: METRO ART HOTEL/); assert.match(r.texto, /no creó ni concilió nada/);
  assert.deepEqual((montar(), (await (async () => { const m = montar(); await ejecutarComandoPreguntas(1, "581,92", m.deps); return m.enviados; })())), ["a"], "también por monto");
});
test("sin texto y con varias pendientes lista y pide precisar; con una sola, la reenvía; sin ninguna, lo dice; nada coincide, avisa", async () => {
  const { deps, enviados } = montar();
  const lista = await ejecutarComandoPreguntas(1, "", deps);
  assert.deepEqual(enviados, []); assert.match(lista.texto, /Hay 3 pendientes/); assert.match(lista.texto, /\/preguntas metro/);
  assert.match((await ejecutarComandoPreguntas(1, "inexistente", deps)).texto, /No encuentro ninguna pregunta pendiente que coincida con «inexistente».*Hay 3 pendientes/);
  const vacio = { ...deps, simples: async () => [] };
  assert.match((await ejecutarComandoPreguntas(1, "", vacio as never)).texto, /No hay ninguna propuesta de gasto, pregunta de conciliación ni propuesta de Wobi Seguros pendiente/);
  const uno = { ...deps, simples: async () => [(await deps.simples(1))[0]] };
  const m = montar(); await ejecutarComandoPreguntas(1, "", { ...m.deps, simples: uno.simples }); assert.deepEqual(m.enviados, ["a"]);
});

test("con varias pendientes la lista trae un botón por cada una y otro para empezar por la primera; ninguno cabe mal en el callback", async () => {
  const { deps } = montar();
  const r = await ejecutarComandoPreguntas(1, "", deps);
  const botones = (r.botones ?? []).flat();
  assert.equal(botones.length, 4);
  assert.deepEqual(botones.map((b) => b.callback_data), ["preg_r:primera", "preg_r:s:a", "preg_r:s:b", "preg_r:s:c"]);
  assert.match(botones[1].text, /^🔗 1\. METRO ART HOTEL/);
  assert.ok(botones.every((b) => Buffer.byteLength(b.callback_data ?? "") <= 64));
  assert.equal((await ejecutarComandoPreguntas(1, "metro", deps)).botones, undefined, "con una sola coincidencia no hay lista");
});

test("el botón reenvía solo la pendiente elegida, o la primera, y avisa si ya no existe", async () => {
  const { handleReenviarPreguntaCallback } = await import("./comandoPreguntas");
  const pulsar = async (data: string, m = montar()) => { await handleReenviarPreguntaCallback({ id: "cb", data, message: { chat: { id: 1 } } } as never, m.deps).catch(() => undefined); return m.enviados; };
  assert.deepEqual(await pulsar("preg_r:s:b"), ["b"]);
  assert.deepEqual(await pulsar("preg_r:primera"), ["a"]);
  assert.deepEqual(await pulsar("preg_r:s:inexistente"), []);
});

test("el texto de búsqueda ignora la puntuación final, los acentos y las mayúsculas (caso «casa peppe.»)", async () => {
  const propuesta = { id: "p1", proveedor: "Casa Peppe (Il Gusto S.A.S.)", concepto: "Desayuno restaurante — Medellín", monto: 64463, moneda: "COP" } as never;
  for (const texto of ["casa peppe.", "Casa  Peppe,", "CASA PEPPE", "il gusto s.a.s", "medellin", "«casa peppe»"]) {
    const enviados: string[] = [];
    const deps = { ...montar().deps, propuestas: async () => [propuesta], simples: async () => [], reenviarPropuesta: async (p: { id: string }) => { enviados.push(p.id); } };
    const r = await ejecutarComandoPreguntas(1, texto, deps as never);
    assert.deepEqual(enviados, ["p1"], texto);
    assert.match(r.texto, /Reenvié al final del chat/, texto);
  }
  const deps = { ...montar().deps, propuestas: async () => [propuesta], simples: async () => [] };
  assert.match((await ejecutarComandoPreguntas(1, "pizzeria.", deps as never)).texto, /No encuentro ninguna pregunta pendiente/);
});

test("un importe con punto o coma finales también se encuentra («142,48.»)", async () => {
  const { importeDeBusqueda } = await import("./reenviarPreguntaPendiente");
  assert.equal(importeDeBusqueda("142,48."), 142.48);
  assert.equal(importeDeBusqueda("  581.92 "), 581.92);
  assert.ok(!(importeDeBusqueda("metro") > 0), "un nombre no es un importe");
  const { deps, enviados } = montar();
  await ejecutarComandoPreguntas(1, "142,48.", deps);
  assert.deepEqual(enviados, ["c"]);
});

test("una propuesta de Wobi Seguros pendiente se reenvía con /preguntas (caso Acodrid 08-10: quedó enterrada) y no se confunde con los gastos", async () => {
  const { deps } = montar();
  const reenviados: string[] = [];
  const seguros = { id: "scb7741605", chatId: 1, messageId: 6628, accion: "recordar", datos: JSON.stringify({ tipo: "pendiente_carlos", texto: "Acodrid confirmó la transferencia de 323,24 € del recibo 2026/138406." }), cita: "x", creadoEn: 0 };
  const conSeguros: DependenciasComandoPreguntas = { ...deps, simples: async () => [], seguros: async () => [seguros] as never, reenviarSeguros: async (c) => { reenviados.push((c as { id: string }).id); } };
  const r = await ejecutarComandoPreguntas(1, "", conSeguros);
  assert.deepEqual(reenviados, ["scb7741605"]);
  assert.match(r.texto, /Propuesta de Wobi Seguros: Acodrid confirmó/);
  const porTexto = montar(); const rs: string[] = [];
  await ejecutarComandoPreguntas(1, "acodrid", { ...porTexto.deps, seguros: async () => [seguros] as never, reenviarSeguros: async (c) => { rs.push((c as { id: string }).id); } });
  assert.deepEqual(rs, ["scb7741605"], "buscar por «acodrid» encuentra la de Seguros");
  assert.deepEqual(porTexto.enviados, [], "y no reenvía ningún gasto");
});
