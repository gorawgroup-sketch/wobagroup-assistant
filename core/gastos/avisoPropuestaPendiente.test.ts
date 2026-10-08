import assert from "node:assert/strict";
import test from "node:test";
import { FrenoAvisoPropuesta, VENTANA_AVISO_MS, type AlmacenAvisos } from "./avisoPropuestaPendiente";

function almacenEnMemoria(): AlmacenAvisos & { filas: Map<string, number>; escrituras: number } {
  const filas = new Map<string, number>(); let siguiente = 2; const idx = new Map<string, number>();
  const a = {
    filas, escrituras: 0,
    async cargar() { return new Map([...filas.entries()].map(([id, ultimo]) => [id, { fila: idx.get(id) ?? 2, ultimo }])); },
    async guardar(id: string, ultimo: number, fila?: number) { a.escrituras++; filas.set(id, ultimo); if (!idx.has(id)) idx.set(id, fila ?? siguiente++); return idx.get(id)!; },
    async purgar(rows: number[]) { for (const [id, f] of idx) if (rows.includes(f)) { filas.delete(id); idx.delete(id); } },
  };
  return a;
}

test("un aviso por propuesta cada 10 min: el primero pasa, los siguientes no, y vuelve a pasar pasada la ventana", async () => {
  let t = 1_000_000; const f = new FrenoAvisoPropuesta(almacenEnMemoria(), () => t);
  assert.equal(await f.puedeAvisar("p1"), true);
  assert.equal(await f.puedeAvisar("p1"), false);
  t += VENTANA_AVISO_MS - 1;
  assert.equal(await f.puedeAvisar("p1"), false);
  t += 2;
  assert.equal(await f.puedeAvisar("p1"), true);
  assert.equal(await f.puedeAvisar("p2"), true, "otra propuesta tiene su propio aviso");
});

test("caso real: 58 adjuntos procesados a la vez dejan pasar exactamente UN aviso", async () => {
  const f = new FrenoAvisoPropuesta(almacenEnMemoria(), () => 5_000);
  const r = await Promise.all(Array.from({ length: 58 }, () => f.puedeAvisar("128c0377")));
  assert.equal(r.filter(Boolean).length, 1);
});

test("el freno sobrevive a un reinicio: una instancia nueva con el mismo registro durable no vuelve a avisar", async () => {
  const almacen = almacenEnMemoria(); let t = 10_000;
  assert.equal(await new FrenoAvisoPropuesta(almacen, () => t).puedeAvisar("p1"), true);
  t += 60_000; // un despliegue un minuto después
  assert.equal(await new FrenoAvisoPropuesta(almacen, () => t).puedeAvisar("p1"), false);
});

test("sin poder leer el registro se avisa (el comportamiento de siempre) y un fallo al guardar no rompe nada", async () => {
  const silenciar = console.error; console.error = () => undefined;
  try {
    const roto: AlmacenAvisos = { cargar: async () => { throw new Error("429"); }, guardar: async () => 2, purgar: async () => undefined };
    assert.equal(await new FrenoAvisoPropuesta(roto, () => 1).puedeAvisar("p1"), true);
    const sinEscritura: AlmacenAvisos = { cargar: async () => new Map(), guardar: async () => { throw new Error("429"); }, purgar: async () => undefined };
    const f = new FrenoAvisoPropuesta(sinEscritura, () => 1);
    assert.equal(await f.puedeAvisar("p1"), true);
    assert.equal(await f.puedeAvisar("p1"), false, "aunque no se pudo guardar, la memoria ya frena");
  } finally { console.error = silenciar; }
});
