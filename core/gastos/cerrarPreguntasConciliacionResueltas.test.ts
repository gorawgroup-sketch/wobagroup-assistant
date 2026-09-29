import assert from "node:assert/strict";
import test from "node:test";
import { cerrarPreguntasConciliacionResueltas, EDAD_MINIMA_PREGUNTA_MS } from "./cerrarPreguntasConciliacionResueltas";
import type { ConciliacionPendiente } from "./conciliacionPendienteStore";

const AHORA = 10_000_000_000;
function pendiente(id: string, extra: Partial<ConciliacionPendiente> = {}): ConciliacionPendiente {
  return { id, empresa: "Footprint", monto: 10, fecha: "2026-09-25", descripcionGasto: `Gasto ${id}`, chatId: 1,
    creadoEn: AHORA - EDAD_MINIMA_PREGUNTA_MS - 1, gastoId: `g-${id}`, moneda: "USD", proveedor: "P",
    deColaCorreo: true, mensajeIdGmail: `m-${id}`, threadIdGmail: `t-${id}`, comprobanteConfirmado: true, ...extra };
}
function montar(pendientes: ConciliacionPendiente[], estados: Record<string, string | Error>, fallaCierre = false) {
  const vivos = new Map(pendientes.map((p) => [p.id, p]));
  const cierres: string[] = []; const avances: string[] = []; const avisos: string[] = [];
  const deps = {
    listar: async () => [...vivos.values()],
    leerConciliacion: async (_e: unknown, gastoId: string) => { const v = estados[gastoId]; if (v instanceof Error) throw v; return v; },
    consumir: async (id: string) => { const p = vivos.get(id); vivos.delete(id); return p; },
    restaurar: async (p: ConciliacionPendiente) => { vivos.set(p.id, p); return p; },
    registrarCierre: async (p: ConciliacionPendiente) => { if (fallaCierre) throw new Error("sheets"); cierres.push(p.id); },
    avanzarCola: async (_c: number, i: { mensajeId?: string }) => { avances.push(i.mensajeId ?? ""); return false; },
    avisar: async (_c: number, t: string) => { avisos.push(t); },
    ahora: () => AHORA,
  };
  return { deps, vivos, cierres, avances, avisos };
}

test("cierra solo las preguntas cuya conciliación está confirmada por lectura", async () => {
  const m = montar([pendiente("a"), pendiente("b"), pendiente("c"), pendiente("d")],
    { "g-a": "conciliada", "g-b": "nueva", "g-c": "revision", "g-d": new Error("502") });
  const r = await cerrarPreguntasConciliacionResueltas(m.deps as never);
  assert.deepEqual(r.cerradas, ["Gasto a"]);
  assert.equal(r.errores, 1);
  assert.deepEqual([...m.vivos.keys()].sort(), ["b", "c", "d"]);
  assert.deepEqual(m.cierres, ["a"]);
  assert.deepEqual(m.avances, ["m-a"]);
  assert.equal(m.avisos.length, 1);
});

test("no toca una pregunta recién enviada ni avisa si no cerró nada", async () => {
  const m = montar([pendiente("a", { creadoEn: AHORA - 1000 })], { "g-a": "conciliada" });
  const r = await cerrarPreguntasConciliacionResueltas(m.deps as never);
  assert.equal(r.revisadas, 0);
  assert.equal(m.vivos.size, 1);
  assert.equal(m.avisos.length, 0);
});

test("si el cierre del correo falla, la pregunta se repone", async () => {
  const m = montar([pendiente("a")], { "g-a": "conciliada" }, true);
  const r = await cerrarPreguntasConciliacionResueltas(m.deps as never);
  assert.equal(r.errores, 1);
  assert.deepEqual(r.cerradas, []);
  assert.equal(m.vivos.size, 1);
});

test("una pregunta fuera de la cola de correo se cierra sin tocar ningún correo", async () => {
  const m = montar([pendiente("a", { deColaCorreo: false })], { "g-a": "conciliada" });
  const r = await cerrarPreguntasConciliacionResueltas(m.deps as never);
  assert.deepEqual(r.cerradas, ["Gasto a"]);
  assert.deepEqual(m.cierres, []);
});
