import assert from "node:assert/strict";
import test from "node:test";
import { revisarAdjuntosDuplicados, UMBRAL_ADJUNTOS_SOSPECHOSO, VENTANA_DIAS_ADJUNTOS, type DepsAdjuntosDuplicados } from "./revisarAdjuntosDuplicados";

function montar(cuentas: Record<string, number | Error>, admins = [{ userId: 1 }, { userId: 2 }]) {
  const avisos: Array<{ userId: number; texto: string }> = [];
  let desdeRecibido = 0;
  const deps: DepsAdjuntosDuplicados = {
    ahora: () => 1_000_000_000_000,
    comprasEditadasDesde: async (d) => { desdeRecibido = d; return Object.keys(cuentas).map((id) => ({ empresa: "Footprint" as const, purchaseId: id })); },
    contarAdjuntos: async (_e, id) => { const v = cuentas[id]; if (v instanceof Error) throw v; return v; },
    admins: async () => admins,
    avisar: async (userId, texto) => { avisos.push({ userId, texto }); },
  };
  return { deps, avisos, desde: () => desdeRecibido };
}

test("sin duplicados: silencio total (no se consulta ni a los admins) y se mira solo la ventana reciente", async () => {
  const m = montar({ a: 1, b: 2, c: 3 });
  const r = await revisarAdjuntosDuplicados(m.deps);
  assert.equal(r.sospechosas.length, 0); assert.equal(m.avisos.length, 0);
  assert.equal(m.desde(), 1_000_000_000_000 - VENTANA_DIAS_ADJUNTOS * 86_400_000);
});

test("una edición legítima (2 o 4 copias… hasta 3) no alarma; a partir del umbral sí, con el recuento real y sin cambiar nada", async () => {
  assert.equal(UMBRAL_ADJUNTOS_SOSPECHOSO, 4);
  const m = montar({ normal: 3, doble: 4, enorme: 32768 });
  const r = await revisarAdjuntosDuplicados(m.deps);
  assert.deepEqual(r.sospechosas.map((s) => [s.purchaseId, s.adjuntos]).sort(), [["doble", 4], ["enorme", 32768]]);
  assert.equal(m.avisos.length, 2, "se avisa a cada admin");
  const t = m.avisos[0].texto;
  assert.match(t, /enorme · 32768 adjuntos/); assert.match(t, /No se ha cambiado nada/); assert.doesNotMatch(t, /normal/);
  assert.ok(t.indexOf("enorme") < t.indexOf("doble"), "la más grave primero");
});

test("una lectura fallida NO se toma por «sin duplicados»: se avisa de que no se pudo comprobar", async () => {
  const m = montar({ ok: 1, caida: new Error("503 Holded") });
  const r = await revisarAdjuntosDuplicados(m.deps);
  assert.equal(r.sinLeer, 1);
  assert.equal(m.avisos.length, 2); assert.match(m.avisos[0].texto, /no pudo comprobar/); assert.match(m.avisos[0].texto, /1 compra\(s\) no se pudieron leer/);
});

test("sin admins no revienta y devuelve lo encontrado", async () => {
  const m = montar({ x: 100 }, []);
  const r = await revisarAdjuntosDuplicados(m.deps);
  assert.equal(r.sospechosas.length, 1); assert.equal(m.avisos.length, 0);
});
