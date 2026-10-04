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
  };
  return { deps, enviados };
}
test("con texto que identifica una sola pregunta la reenvía y no toca nada más", async () => {
  const { deps, enviados } = montar();
  const r = await ejecutarComandoPreguntas(1, "metro", deps);
  assert.deepEqual(enviados, ["a"]); assert.match(r, /Reenvié al final del chat: Conciliar: METRO ART HOTEL/); assert.match(r, /no creó ni concilió nada/);
  assert.deepEqual((montar(), (await (async () => { const m = montar(); await ejecutarComandoPreguntas(1, "581,92", m.deps); return m.enviados; })())), ["a"], "también por monto");
});
test("sin texto y con varias pendientes lista y pide precisar; con una sola, la reenvía; sin ninguna, lo dice; nada coincide, avisa", async () => {
  const { deps, enviados } = montar();
  const lista = await ejecutarComandoPreguntas(1, "", deps);
  assert.deepEqual(enviados, []); assert.match(lista, /Hay 3 pendientes/); assert.match(lista, /\/preguntas metro/);
  assert.match(await ejecutarComandoPreguntas(1, "inexistente", deps), /No encuentro ninguna pregunta pendiente que coincida con «inexistente».*Hay 3 pendientes/);
  const vacio = { ...deps, simples: async () => [] };
  assert.match(await ejecutarComandoPreguntas(1, "", vacio as never), /No hay ninguna propuesta de gasto ni pregunta de conciliación pendiente/);
  const uno = { ...deps, simples: async () => [(await deps.simples(1))[0]] };
  const m = montar(); await ejecutarComandoPreguntas(1, "", { ...m.deps, simples: uno.simples }); assert.deepEqual(m.enviados, ["a"]);
});
